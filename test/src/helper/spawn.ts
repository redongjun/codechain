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

import { ChildProcess, spawn } from "child_process";
import { SDK } from "codechain-sdk";
import {
    SignedParcel,
    Transaction,
    AssetTransferTransaction,
    H256,
    Invoice,
    Parcel,
    U256,
    AssetTransferInput,
    PlatformAddress,
    AssetTransferAddress
} from "codechain-sdk/lib/core/classes";
import { mkdtempSync, appendFileSync } from "fs";
import { createInterface as createReadline } from "readline";
import * as mkdirp from "mkdirp";
import { wait } from "./promise";
import { P2PKHBurn } from "codechain-sdk/lib/key/P2PKHBurn";
import { P2PKH } from "codechain-sdk/lib/key/P2PKH";

const faucetSecret = `ede1d4ccb4ec9a8bbbae9a13db3f4a7b56ea04189be86ac3a6a439d9a0a1addd`;
const faucetAddress = PlatformAddress.fromAccountId(
    SDK.util.getAccountIdFromPrivate(
        `ede1d4ccb4ec9a8bbbae9a13db3f4a7b56ea04189be86ac3a6a439d9a0a1addd`
    )
);
const projectRoot = `${__dirname}/../../..`;

export type SchemeFilepath = string;
export type ChainType =
    | "solo"
    | "simple_poa"
    | "tendermint"
    | "cuckoo"
    | "blake_pow"
    | "husky"
    | SchemeFilepath;

export default class CodeChain {
    private static idCounter = 0;
    private _id: number;
    private _sdk: SDK;
    private _localKeyStorePath: string;
    private _dbPath: string;
    private _ipcPath: string;
    private _keysPath: string;
    private _logFile: string;
    private _logPath: string;
    private _logFlag: boolean;
    private _chain: ChainType;
    private argv: string[];
    private process?: ChildProcess;

    public get id(): number {
        return this._id;
    }
    public get sdk(): SDK {
        return this._sdk;
    }
    public get localKeyStorePath(): string {
        return this._localKeyStorePath;
    }
    public get dbPath(): string {
        return this._dbPath;
    }
    public get ipcPath(): string {
        return this._ipcPath;
    }
    public get keysPath(): string {
        return this._keysPath;
    }
    public get logFile(): string {
        return this._logFile;
    }
    public get logPath(): string {
        return this._logPath;
    }
    public get logFlag(): boolean {
        return this._logFlag;
    }
    public get rpcPort(): number {
        return 8081 + this.id;
    }
    public get port(): number {
        return 3486 + this.id;
    }
    public get secretKey(): number {
        return 1 + this.id;
    }
    public get chain(): ChainType {
        return this._chain;
    }

    constructor(
        options: { chain?: ChainType; argv?: string[]; logFlag?: boolean } = {}
    ) {
        const { chain, argv, logFlag } = options;
        this._id = CodeChain.idCounter++;

        mkdirp.sync(`${projectRoot}/db/`);
        mkdirp.sync(`${projectRoot}/keys/`);
        mkdirp.sync(`${projectRoot}/test/log/`);
        this._dbPath = mkdtempSync(`${projectRoot}/db/`);
        this._ipcPath = `/tmp/jsonrpc.${this.id}.ipc`;
        this._keysPath = mkdtempSync(`${projectRoot}/keys/`);
        this._localKeyStorePath = `${this.keysPath}/keystore.db`;
        this._logFlag = logFlag || false;
        this._logFile = `${new Date().toISOString().replace(/[-:.]/g, "_")}.${
            this.id
        }.log`;
        this._logPath = `${projectRoot}/test/log/${this._logFile}`;
        this._sdk = new SDK({ server: `http://localhost:${this.rpcPort}` });
        this._chain = chain || "solo";
        this.argv = argv || [];
    }

    public async start(argv: string[] = [], log_level = "trace,mio=warn,tokio=warn,hyper=warn") {
        const useDebugBuild = process.env.NODE_ENV !== "production";
        process.env.RUST_LOG = log_level;
        // NOTE: https://github.com/CodeChain-io/codechain/issues/348
        process.env.WAIT_BEFORE_SHUTDOWN = "0";

        // Resolves when CodeChain initialization completed.
        return new Promise((resolve, reject) => {
            this.process = spawn(
                `target/${useDebugBuild ? "debug" : "release"}/codechain`,
                [
                    ...this.argv,
                    ...argv,
                    "--chain",
                    this.chain,
                    "--db-path",
                    this.dbPath,
                    "--no-ipc",
                    "--keys-path",
                    this.keysPath,
                    "--no-ws",
                    "--jsonrpc-port",
                    this.rpcPort.toString(),
                    "--port",
                    this.port.toString(),
                    "--instance-id",
                    this.id.toString()
                ],
                {
                    cwd: projectRoot,
                    env: process.env
                }
            );

            this.process
                .on("error", e => {
                    reject(e);
                })
                .on("close", (code, _signal) => {
                    reject(Error(`CodeChain exited with code ${code}`));
                });

            const readline = createReadline({ input: this.process!.stderr });
            let flag = false;
            readline.on("line", (line: string) => {
                if (line.includes("Initialization complete")) {
                    flag = true;
                    resolve();
                }
                if (this.logFlag && flag) {
                    appendFileSync(this.logPath, line + "\n");
                }
            });
        });
    }

    public async connect(peer: CodeChain) {
        if (!this.process) {
            return Promise.reject(Error("process isn't available"));
        }
        await this.sdk.rpc.network.connect(
            "127.0.0.1",
            peer.port
        );
        while (
            (await this.sdk.rpc.network.isConnected("127.0.0.1", peer.port)) ===
            false
        ) {
            await wait(250);
        }
    }

    public async disconnect(peer: CodeChain) {
        if (!this.process) {
            return Promise.reject(Error("process isn't available"));
        }
        return this.sdk.rpc.network.disconnect("127.0.0.1", peer.port);
    }

    public async waitPeers(n: number) {
        while (n > (await this.sdk.rpc.network.getPeerCount())) {
            await wait(500);
        }
        return;
    }

    public async waitBlockNumberSync(peer: CodeChain) {
        while (
            (await this.getBestBlockNumber()) !==
            (await peer.getBestBlockNumber())
        ) {
            await wait(500);
        }
    }

    public async getBestBlockNumber() {
        return this.sdk.rpc.chain.getBestBlockNumber();
    }

    public async getBestBlockHash() {
        return this.sdk.rpc.chain.getBlockHash(await this.getBestBlockNumber());
    }

    public async createP2PKHAddress() {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkh = this.sdk.key.createP2PKH({ keyStore });
        return p2pkh.createAddress();
    }

    public async signTransactionP2PKHBurn(
        txInput: AssetTransferInput,
        txhash: H256
    ) {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkhBurn = this.sdk.key.createP2PKHBurn({ keyStore });
        if (txInput.prevOut.parameters === undefined) {
            throw Error(`prevOut.parameters is undefined`);
        }
        const publicKeyHash = Buffer.from(
            txInput.prevOut.parameters[0]
        ).toString("hex");
        txInput.setLockScript(P2PKHBurn.getLockScript());
        txInput.setUnlockScript(
            await p2pkhBurn.createUnlockScript(publicKeyHash, txhash)
        );
    }

    public async signTransactionP2PKH(
        txInput: AssetTransferInput,
        txhash: H256
    ) {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkh = this.sdk.key.createP2PKH({ keyStore });
        if (txInput.prevOut.parameters === undefined) {
            throw Error(`prevOut.parameters is undefined`);
        }
        const publicKeyHash = Buffer.from(
            txInput.prevOut.parameters[0]
        ).toString("hex");
        txInput.setLockScript(P2PKH.getLockScript());
        txInput.setUnlockScript(
            await p2pkh.createUnlockScript(publicKeyHash, txhash)
        );
    }

    public async createP2PKHBurnAddress() {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkhBurn = this.sdk.key.createP2PKHBurn({ keyStore });
        return p2pkhBurn.createAddress();
    }

    public async createPlatformAddress() {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        return this.sdk.key.createPlatformAddress({ keyStore });
    }

    public async payment(
        recipient: string | PlatformAddress,
        amount: U256 | string | number
    ) {
        const parcel = this.sdk.core
            .createPaymentParcel({
                recipient,
                amount
            })
            .sign({
                secret: faucetSecret,
                nonce: await this.sdk.rpc.chain.getNonce(faucetAddress),
                fee: 10
            });
        const hash = await this.sdk.rpc.chain.sendSignedParcel(parcel);
        const invoice = (await this.sdk.rpc.chain.getParcelInvoice(hash, {
            timeout: 300 * 1000
        })) as Invoice | null;
        if (invoice === null || !invoice.success) {
            throw Error(
                `An error occurred while payment: ${invoice && invoice.error}`
            );
        }
    }

    public async sendParcel(
        parcel: Parcel,
        params: {
            account: string | PlatformAddress;
            fee?: number | string | U256;
            nonce?: number | string | U256;
        }
    ) {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const { account, fee = 10 } = params;
        const { nonce = await this.sdk.rpc.chain.getNonce(account) } = params;
        const signedParcel = await this.sdk.key.signParcel(parcel, {
            keyStore,
            account,
            fee,
            nonce
        });
        return this.sdk.rpc.chain.sendSignedParcel(signedParcel);
    }

    public async sendTransaction(
        tx: Transaction,
        options?: {
            nonce?: U256 | number;
            awaitInvoice?: boolean;
            secret?: string;
        }
    ) {
        const {
            nonce = (await this.sdk.rpc.chain.getNonce(faucetAddress)) || 0,
            awaitInvoice = true,
            secret = faucetSecret
        } = options || {};
        const parcel = this.sdk.core
            .createAssetTransactionGroupParcel({
                transactions: [tx]
            })
            .sign({
                secret,
                fee: 10 + this.id,
                nonce
            });
        await this.sdk.rpc.chain.sendSignedParcel(parcel);
        if (awaitInvoice) {
            return this.sdk.rpc.chain.getTransactionInvoice(tx.hash(), {
                timeout: 300 * 1000
            });
        }
    }

    public async mintAsset(params: {
        amount: number;
        recipient?: string | AssetTransferAddress;
        secret?: string;
    }) {
        const {
            amount,
            recipient = await this.createP2PKHAddress(),
            secret
        } = params;
        const tx = this.sdk.core.createAssetMintTransaction({
            scheme: {
                shardId: 0,
                worldId: 0,
                metadata: "",
                amount
            },
            recipient
        });
        await this.sendTransaction(tx, { secret });
        const asset = await this.sdk.rpc.chain.getAsset(tx.hash(), 0);
        if (asset === null) {
            throw Error(`Failed to mint asset`);
        }
        return { asset };
    }

    public async sendTransactions(
        txs: Transaction[],
        options?: { nonce?: U256 | number; awaitInvoice?: boolean }
    ) {
        const {
            nonce = (await this.sdk.rpc.chain.getNonce(faucetAddress)) || 0,
            awaitInvoice = true
        } = options || {};
        const parcel = this.sdk.core
            .createAssetTransactionGroupParcel({
                transactions: txs
            })
            .sign({
                secret: faucetSecret,
                fee: 10 + this.id,
                nonce
            });
        const parcelHash = await this.sdk.rpc.chain.sendSignedParcel(parcel);
        if (awaitInvoice) {
            return this.sdk.rpc.chain.getParcelInvoice(parcelHash, {
                timeout: 300 * 1000
            });
        }
    }

    public async mintAssets(params: { count: number; nonce?: U256 | number }) {
        const { count, nonce } = params;
        let txs: Transaction[] = [];
        const recipient = await this.createP2PKHAddress();
        for (let i = 0; i < count; i++) {
            const tx = this.sdk.core.createAssetMintTransaction({
                scheme: {
                    shardId: 0,
                    worldId: 0,
                    metadata: "",
                    amount: 1
                },
                recipient
            });
            txs.push(tx);
        }
        await this.sendTransactions(txs, { nonce, awaitInvoice: false });
    }

    public async signTransferInput(
        tx: AssetTransferTransaction,
        index: number
    ) {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkh = this.sdk.key.createP2PKH({ keyStore });
        await p2pkh.signInput(tx, index);
    }

    public async signTransferBurn(tx: AssetTransferTransaction, index: number) {
        const keyStore = await this.sdk.key.createLocalKeyStore(
            this.localKeyStorePath
        );
        const p2pkhBurn = this.sdk.key.createP2PKHBurn({ keyStore });
        await p2pkhBurn.signBurn(tx, index);
    }

    public async setRegularKey(
        key: any,
        options?: {
            nonce?: U256 | number;
            awaitInvoice?: boolean;
            secret?: any;
        }
    ) {
        const {
            nonce = (await this.sdk.rpc.chain.getNonce(faucetAddress)) || 0,
            awaitInvoice = true,
            secret = faucetSecret
        } = options || {};
        const parcel = this.sdk.core
            .createSetRegularKeyParcel({
                key
            })
            .sign({
                secret,
                fee: 10,
                nonce
            });

        const hash = await this.sdk.rpc.chain.sendSignedParcel(parcel);
        if (awaitInvoice) {
            return (await this.sdk.rpc.chain.getParcelInvoice(hash, {
                timeout: 300 * 1000
            })) as Invoice;
        }
    }

    public async sendSignedParcel(options?: {
        nonce?: U256 | number;
        awaitInvoice?: boolean;
        recipient?: PlatformAddress | string;
        amount?: number;
        secret?: any;
        fee?: number;
    }): Promise<SignedParcel> {
        const {
            nonce = (await this.sdk.rpc.chain.getNonce(faucetAddress)) || 0,
            awaitInvoice = true,
            recipient = "tccqruq09sfgax77nj4gukjcuq69uzeyv0jcs7vzngg",
            amount = 0,
            secret = faucetSecret,
            fee = 10 + this.id
        } = options || {};
        const parcel = this.sdk.core
            .createPaymentParcel({
                recipient,
                amount
            })
            .sign({
                secret,
                fee,
                nonce
            });
        const hash = await this.sdk.rpc.chain.sendSignedParcel(parcel);
        if (awaitInvoice) {
            await this.sdk.rpc.chain.getParcelInvoice(hash, {
                timeout: 300 * 1000
            });
            return (await this.sdk.rpc.chain.getParcel(hash)) as SignedParcel;
        }
        return parcel;
    }

    public sendSignedParcelWithRlpBytes(rlpBytes: Buffer): Promise<H256> {
        return new Promise((resolve, reject) => {
            const bytes = Array.from(rlpBytes)
                .map(
                    byte =>
                        byte < 0x10
                            ? `0${byte.toString(16)}`
                            : byte.toString(16)
                )
                .join("");
            this.sdk.rpc
                .sendRpcRequest("chain_sendSignedParcel", [`0x${bytes}`])
                .then(result => {
                    try {
                        resolve(new H256(result));
                    } catch (e) {
                        reject(
                            Error(
                                `Expected sendSignedParcel() to return a value of H256, but an error occurred: ${e.toString()}`
                            )
                        );
                    }
                })
                .catch(reject);
        });
    }

    public async clean() {
        return new Promise(resolve => {
            if (!this.process) {
                return resolve();
            }
            this.process.on("exit", (code, signal) => {
                if (code !== 0) {
                    console.error(
                        `CodeChain(${
                            this.id
                        }) exited with code ${code}, ${signal}`
                    );
                }
                resolve();
            });
            this.process.kill();
            this.process = undefined;
        });
    }
}
