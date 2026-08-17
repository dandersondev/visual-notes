export interface RoomDocumentStore<T> {
  ready(): Promise<void>;
  load(roomId: string): Promise<T>;
  save(roomId: string, value: T): Promise<void>;
  delete(roomId: string): Promise<void>;
  list(): Promise<T[]>;
}

export interface AssetBlobStore {
  ready(): Promise<void>;
  putIfAbsent(hash: string, bytes: Uint8Array): Promise<void>;
  size(hash: string): Promise<number>;
  read(hash: string, range?: { start: number; end: number }): Promise<Uint8Array>;
  delete(hash: string): Promise<void>;
}

export interface CollaborationPersistenceModule {
  RoomDocumentStore: new <T>(
    directory: string,
    validate: (value: unknown) => T,
    fileName: (roomId: string) => string,
  ) => RoomDocumentStore<T>;
  AssetBlobStore: new (directory: string) => AssetBlobStore;
  joinPath(parent: string, child: string): string;
}
