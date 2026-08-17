// The standalone build uses Node-backed persistence. The embedded build
// aliases this module to persistence-obsidian.ts in esbuild.mjs.
export { FileRoomDocumentStore as RoomDocumentStore, FileAssetBlobStore as AssetBlobStore, joinPath } from './persistence';
