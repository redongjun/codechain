// Copyright 2018 Kodebox, Inc.
// This file is part of CodeChain.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use parking_lot::{Mutex, RwLock};
use rand::{thread_rng, Rng};
use std::collections::HashMap;
use std::sync::Arc;

use cbytes::Bytes;
use ccore::{BlockChainClient, BlockId, ChainNotify};
use cnetwork::{Api, Extension, NodeId};
use ctypes::{H256, U256};
use rlp::{Encodable, UntrustedRlp};

use manager::DownloadManager;
use message::Message;

const EXTENSION_NAME: &'static str = "block-propagation";
const SYNC_TIMER_ID: usize = 0;
const SYNC_TIMER_INTERVAL: u64 = 1000;

enum RequestInfo {
    Header(H256),
    Bodies(Vec<H256>),
}

struct Peer {
    total_score: U256,
    best_hash: H256,
    last_request: Option<RequestInfo>,
}

pub struct BlockSyncExtension {
    peers: RwLock<HashMap<NodeId, Peer>>,
    client: Arc<BlockChainClient>,
    manager: Mutex<DownloadManager>,
    api: Mutex<Option<Arc<Api>>>,
}

impl BlockSyncExtension {
    pub fn new(client: Arc<BlockChainClient>) -> Arc<Self> {
        let best_block = client.block(BlockId::Latest).expect("BlockSyncExtension: Best block should exist").decode();
        Arc::new(Self {
            peers: RwLock::new(HashMap::new()),
            client,
            manager: Mutex::new(DownloadManager::new(best_block)),
            api: Mutex::new(None),
        })
    }
}

impl Extension for BlockSyncExtension {
    fn name(&self) -> String {
        String::from(EXTENSION_NAME)
    }
    fn need_encryption(&self) -> bool {
        false
    }

    fn on_initialize(&self, api: Arc<Api>) {
        self.peers.write().clear();
        api.set_timer(SYNC_TIMER_ID, SYNC_TIMER_INTERVAL);
        *self.api.lock() = Some(api);
    }

    fn on_node_added(&self, id: &NodeId) {
        self.api.lock().as_ref().map(|api| api.connect(id));
    }
    fn on_node_removed(&self, id: &NodeId) {
        self.peers.write().remove(id);
    }

    fn on_connected(&self, id: &NodeId) {
        let chain_info = self.client.chain_info();
        self.send_message(
            id,
            Message::Status {
                total_score: chain_info.total_score,
                best_hash: chain_info.best_block_hash,
                genesis_hash: chain_info.genesis_hash,
            },
        );
    }
    fn on_connection_allowed(&self, id: &NodeId) {
        self.on_connected(id);
    }

    fn on_message(&self, id: &NodeId, data: &Vec<u8>) {
        if let Ok(received_message) = UntrustedRlp::new(data).as_val() {
            if !self.is_valid_message(id, &received_message) {
                return
            }
            self.apply_message(id, &received_message);

            // Do nothing and return if status message is received
            if received_message.is_status() {
                return
            }

            // Create next message for peer
            let next_message = match received_message {
                Message::RequestHeaders {
                    start_hash,
                    max_count,
                } => Some(self.create_headers_message(start_hash, max_count)),
                Message::RequestBodies(hashes) => Some(self.create_bodies_message(hashes)),
                _ => {
                    let total_score = self.client
                        .block_total_score(BlockId::Hash(self.manager.lock().best_hash()))
                        .expect("Best block of download manager should exist in chain");
                    // FIXME: Check if this statement really needs `clone`
                    let peer_total_score =
                        self.peers.read().get(id).expect("Peer should exist for valid message").total_score.clone();
                    if peer_total_score > total_score {
                        self.manager.lock().create_request()
                    } else {
                        None
                    }
                }
            };

            self.record_last_request(id, &next_message);

            if let Some(message) = next_message {
                self.send_message(id, message);
            }
        } else {
            info!("BlockSyncExtension: invalid message from peer {}", id);
        }
    }

    fn on_close(&self) {
        *self.api.lock() = None
    }

    fn on_timeout(&self, timer_id: usize) {
        debug_assert_eq!(timer_id, SYNC_TIMER_ID);
        let mut peer_ids: Vec<_> = self.peers
            .read()
            .iter()
            .filter(|&(_, peer)| peer.last_request.is_none())
            .map(|(id, _)| id)
            .cloned()
            .collect();
        // Shuffle peers to avoid requesting messages in deterministic order
        thread_rng().shuffle(peer_ids.as_mut_slice());
        for id in peer_ids {
            let next_message = self.manager.lock().create_request();
            self.record_last_request(&id, &next_message);
            if let Some(message) = next_message {
                self.send_message(&id, message);
            }
        }
    }
}

impl ChainNotify for BlockSyncExtension {
    fn new_blocks(
        &self,
        _imported: Vec<H256>,
        _invalid: Vec<H256>,
        _enacted: Vec<H256>,
        _retracted: Vec<H256>,
        _sealed: Vec<H256>,
        _proposed: Vec<Bytes>,
        _duration: u64,
    ) {
        // FIXME: Send status message only when block is imported
        let chain_info = self.client.chain_info();
        let peer_ids: Vec<_> = self.peers.read().keys().cloned().collect();
        for id in peer_ids {
            self.send_message(
                &id,
                Message::Status {
                    total_score: chain_info.total_score,
                    best_hash: chain_info.best_block_hash,
                    genesis_hash: chain_info.genesis_hash,
                },
            );
        }
    }
}

impl BlockSyncExtension {
    fn is_valid_message(&self, id: &NodeId, message: &Message) -> bool {
        match message {
            &Message::Status {
                genesis_hash,
                ..
            } => {
                if genesis_hash != self.client.chain_info().genesis_hash {
                    info!("BlockSyncExtension: genesis hash mismatch with peer {}", id);
                    return false
                } else {
                    return true
                }
            }
            _ => {}
        }

        if let Some(last_request) = self.peers.read().get(id).map(|peer| &peer.last_request) {
            match (message, last_request) {
                (&Message::RequestBodies(ref hashes), _) => hashes.len() != 0,
                (&Message::Headers(ref headers), &Some(RequestInfo::Header(start_hash))) => {
                    if headers.len() == 0 {
                        true
                    } else {
                        headers.first().expect("Response is not empty").hash() == start_hash
                    }
                }
                (&Message::Bodies(..), &Some(RequestInfo::Bodies(..))) => true,
                _ => false,
            }
        } else {
            false
        }
    }

    fn apply_message(&self, id: &NodeId, message: &Message) {
        match message {
            &Message::Status {
                total_score,
                best_hash,
                ..
            } => {
                let mut peers = self.peers.write();
                if peers.contains_key(id) {
                    let peer = peers.get_mut(id).expect("Peer list should contain peer for `id`");
                    peer.total_score = total_score;
                    peer.best_hash = best_hash;
                } else {
                    peers.insert(
                        *id,
                        Peer {
                            total_score,
                            best_hash,
                            last_request: None,
                        },
                    );
                }
            }
            &Message::Headers(ref headers) => self.manager.lock().import_headers(headers),
            &Message::Bodies(ref bodies) => self.manager.lock().import_bodies(bodies),
            _ => {}
        };
        // FIXME: Import fully downloaded blocks to client
    }

    fn record_last_request(&self, id: &NodeId, message: &Option<Message>) {
        let mut peers = self.peers.write();
        if let Some(peer) = peers.get_mut(id) {
            match message {
                &Some(Message::RequestHeaders {
                    start_hash,
                    ..
                }) => {
                    peer.last_request = Some(RequestInfo::Header(start_hash));
                }
                &Some(Message::RequestBodies(ref hashes)) => {
                    peer.last_request = Some(RequestInfo::Bodies(hashes.clone()));
                }
                &None => {
                    peer.last_request = None;
                }
                _ => {}
            };
        }
    }

    fn send_message(&self, id: &NodeId, message: Message) {
        self.api.lock().as_ref().map(|api| {
            api.send(id, &message.rlp_bytes().to_vec());
        });
    }

    fn create_headers_message(&self, start_hash: H256, max_count: u64) -> Message {
        let mut headers = Vec::new();
        let mut block_id = BlockId::Hash(start_hash);
        for _ in 0..max_count {
            if let Some(header) = self.client.block_header(block_id) {
                headers.push(header.decode());
                block_id = BlockId::Number(header.number() + 1);
            } else {
                break
            }
        }
        Message::Headers(headers)
    }

    fn create_bodies_message(&self, hashes: Vec<H256>) -> Message {
        let mut bodies = Vec::new();
        for hash in hashes {
            if let Some(body) = self.client.block_body(BlockId::Hash(hash)) {
                bodies.push(body.transactions());
            }
        }
        Message::Bodies(bodies)
    }
}
