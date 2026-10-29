// End-to-end encryption for the bridge (docs/encryption.md): the Matrix Rust crypto core
// (matrix-sdk-crypto, the same as Element's) as a Node binding, keys in a SQLite store on disk.
// The bridge feeds it what /sync returns and sends the requests it asks for; it encrypts
// messages for rooms with m.room.encryption and decrypts m.room.encrypted events.
import { mkdir } from "node:fs/promises";
import {
  CollectStrategy,
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  HistoryVisibility,
  OlmMachine,
  RequestType,
  RoomId,
  StoreType,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";

const VISIBILITY = {
  invited: HistoryVisibility.Invited,
  joined: HistoryVisibility.Joined,
  shared: HistoryVisibility.Shared,
  world_readable: HistoryVisibility.WorldReadable,
};

// `api(method, path, body)` is the bridge's client-server call; `dir` holds the store, one per device.
export async function startCrypto({ api, userId, deviceId, dir }) {
  const store = `${dir}/${deviceId}`;
  await mkdir(store, { recursive: true, mode: 0o700 });
  const machine = await OlmMachine.initialize(new UserId(userId), new DeviceId(deviceId), store, undefined, StoreType.Sqlite);

  // Requests run one batch at a time: the machine must see each answer before it builds the next.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function send(request) {
    const txn = encodeURIComponent(request.txnId ?? "");
    switch (request.type) {
      case RequestType.KeysUpload:
        return api("POST", "/keys/upload", JSON.parse(request.body));
      case RequestType.KeysQuery:
        return api("POST", "/keys/query", JSON.parse(request.body));
      case RequestType.KeysClaim:
        return api("POST", "/keys/claim", JSON.parse(request.body));
      case RequestType.ToDevice:
        return api("PUT", `/sendToDevice/${encodeURIComponent(request.eventType)}/${txn}`, JSON.parse(request.body));
      case RequestType.SignatureUpload:
        return api("POST", "/keys/signatures/upload", JSON.parse(request.body));
      case RequestType.RoomMessage:
        return api("PUT", `/rooms/${encodeURIComponent(request.roomId)}/send/${encodeURIComponent(request.eventType)}/${txn}`, JSON.parse(request.body));
      default:
        return null; // key backup: not used by the bridge
    }
  }

  async function flush() {
    for (const request of await machine.outgoingRequests()) await run(request);
  }

  async function run(request) {
    const response = await send(request);
    if (response && request.id) await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  return {
    // Every /sync response, before its timeline is read: to-device messages carry the room keys.
    receiveSync: (sync) =>
      serial(async () => {
        const lists = sync.device_lists ?? {};
        await machine.receiveSyncChanges(
          JSON.stringify(sync.to_device?.events ?? []),
          new DeviceLists((lists.changed ?? []).map((u) => new UserId(u)), (lists.left ?? []).map((u) => new UserId(u))),
          sync.device_one_time_keys_count ?? {},
          sync.device_unused_fallback_key_types ?? [],
        );
        await flush();
      }),

    // Members of encrypted rooms, so their devices are known before anything is sent to them.
    track: (users) => serial(async () => {
      await machine.updateTrackedUsers(users.map((u) => new UserId(u)));
      await flush();
    }),

    // An m.room.encrypted event as plaintext ({ type, content }), or null while its key is missing.
    decrypt: async (roomId, event) => {
      try {
        const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId));
        const clear = JSON.parse(decrypted.event);
        return { type: clear.type, content: clear.content };
      } catch {
        return null;
      }
    },

    // Shares the room key with every device of `members`, then returns the encrypted content to send.
    encrypt: (roomId, type, content, members, visibility) =>
      serial(async () => {
        const users = members.map((u) => new UserId(u));
        await machine.updateTrackedUsers(users);
        await flush(); // device lists of new members
        // Ask for the members' devices every time: a server may not announce the devices of someone
        // who had none when first seen (invited before ever logging in), and they would get no key.
        await run(machine.queryKeysForUsers(members.map((u) => new UserId(u))));
        const claim = await machine.getMissingSessions(users);
        if (claim) await run(claim);
        const settings = new EncryptionSettings();
        settings.historyVisibility = VISIBILITY[visibility] ?? HistoryVisibility.Shared;
        // Every device of every member, the bots included: there is no device verification yet.
        settings.sharingStrategy = CollectStrategy.AllDevices;
        for (const request of await machine.shareRoomKey(new RoomId(roomId), users, settings)) await run(request);
        return JSON.parse(await machine.encryptRoomEvent(new RoomId(roomId), type, JSON.stringify(content)));
      }),

    close: () => machine.close(),
  };
}
