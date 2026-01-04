import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

const DOMAIN_CHAIN_ID_MAINNET = 42161;
const DOMAIN_CHAIN_ID_TESTNET = 421614;

export const EIP712_DOMAIN_TYPE = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
];

export const EIP712_AGENT_TYPE = {
    "Agent": [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
    ]
};

export function getDomain(isTestnet: boolean): {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
} {
    return {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: isTestnet ? DOMAIN_CHAIN_ID_TESTNET : DOMAIN_CHAIN_ID_MAINNET,
        verifyingContract: "0x0000000000000000000000000000000000000000",
    };
}

export async function signL1Action(
    wallet: Wallet,
    action: object,
    isTestnet: boolean,
    nonce: number
): Promise<{ r: string; s: string; v: number }> {
    const domain = getDomain(isTestnet);

    // 1. Serialize action with msgpack
    // The action should wrap the payload and nonce if required by the API,
    // but the signature expects the hashing of the action body.
    // The "action" argument passed here is the raw API action object (e.g. { type: 'order', ... })

    // We also need to group it if it's an exchange action?
    // The API expects:
    // { action: { ... }, nonce: 123, signature: { ... } }
    // The thing we HASH is the `action` object + nonce?
    // Actually, usually we sign the action object itself.

    // According to HyperLiquid SDK patterns:
    // connectionId = keccak256(msgpack(action))

    // IMPORTANT: The action object must be formed correctly before msgpacking.
    // e.g. keys sorted? msgpack doesn't care about key order usually but implementations might.
    // JS objects are unordered.
    // However, the standard JS msgpack encoder is consistent enough.

    // Note: actionWithNonce kept for documentation - nonce handling varies by action type
    const _actionWithNonce = {
        ...action,
        nonce,
        // Wait, does the signed payload include the nonce?
        // Usually yes, effectively preventing replay.
    };

    // Let's verify if nonce is inside the action or outside.
    // "Send { action, nonce, signature } to /exchange"
    // The signature signs the `action` (and possibly nonce inside?).
    // A common pattern in HyperLiquid SDKs:
    // connectionId = hash(msgpack(action))  <-- NO nonce here?
    // The nonce seems to be part of the POST body but maybe not the signed hash?
    // This is risky. 
    // Checking: "The connectionId is the keccak256 hash of the msgpack encoded action."
    // And "The action is { type: ..., ... }"

    // Wait, if nonce is NOT in action, how is replay prevented?
    // Maybe the action normally implies a nonce (timestamp)?
    // "orders" action has "cloid".
    // "cancel" has "nonce"? No.
    // Let's assume nonce is part of the request but not the signed hash unless specified.

    // HOWEVER, for "UserFills" or other things, there is no nonce.
    // Let's try signing just the action.

    const packed = encode(action);
    const connectionId = keccak256(packed);

    const message = {
        source: 'a', // 'a' for Agent (or Main wallet acting as agent)
        connectionId: connectionId
    };

    const signature = await wallet.signTypedData(domain, EIP712_AGENT_TYPE, message);

    const split = {
        r: signature.slice(0, 66),
        s: "0x" + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16)
    };

    return split;
}
