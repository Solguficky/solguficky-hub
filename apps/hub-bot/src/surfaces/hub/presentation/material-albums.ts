export type AlbumPhoto = {
  fileId: string;
  uniqueId: string;
  caption?: string;
  messageId: number;
};

export type MaterialAlbum = {
  meetupId: string;
  version: number;
  telegramUserId: number;
  photos: readonly AlbumPhoto[];
};

type Group = {
  phase: "collecting" | "ready" | "failed" | "confirmed" | "cancelled";
  photos: AlbumPhoto[];
  inflight: number;
  timer?: ReturnType<typeof setTimeout>;
  expiry: ReturnType<typeof setTimeout>;
  token?: string;
};

// Album updates have no end marker. Drafts are bounded and expire; command
// progress is never kept here. A late update invalidates an unpressed draft.
export function createMaterialAlbums() {
  const groups = new Map<string, Group>();
  const confirmations = new Map<
    string,
    { group: string; album: MaterialAlbum }
  >();
  const limit = 100;
  const lifetime = 5 * 60_000;
  function cancelTimer(group: Group): void {
    if (group.timer !== undefined) clearTimeout(group.timer);
    delete group.timer;
  }
  function fail(group: Group): void {
    cancelTimer(group);
    group.phase = "failed";
    group.photos = [];
    if (group.token !== undefined) confirmations.delete(group.token);
    delete group.token;
  }
  return {
    has(key: string): boolean {
      return groups.has(key);
    },
    begin(
      key: string,
    ): "accepted" | "late" | "late-confirmed" | "ignored" | "full" {
      let group = groups.get(key);
      if (group === undefined) {
        if (groups.size >= limit) return "full";
        const expiry = setTimeout(() => {
          const expired = groups.get(key);
          if (expired !== undefined) {
            cancelTimer(expired);
            if (expired.token !== undefined)
              confirmations.delete(expired.token);
          }
          groups.delete(key);
        }, lifetime);
        expiry.unref();
        group = { phase: "collecting", photos: [], inflight: 0, expiry };
        groups.set(key, group);
      }
      if (group.phase === "ready") {
        fail(group);
        return "late";
      }
      if (group.phase === "confirmed") {
        fail(group);
        return "late-confirmed";
      }
      if (group.phase !== "collecting") return "ignored";
      cancelTimer(group);
      group.inflight += 1;
      return "accepted";
    },
    fail(key: string): void {
      const group = groups.get(key);
      if (group !== undefined) fail(group);
    },
    finish(
      key: string,
      photo: AlbumPhoto,
      ready: (photos: AlbumPhoto[]) => Promise<void>,
    ): boolean {
      const group = groups.get(key);
      if (group === undefined || group.phase !== "collecting") return false;
      group.inflight -= 1;
      if (group.photos.length >= 10) {
        fail(group);
        return false;
      }
      group.photos.push(photo);
      if (group.inflight === 0) {
        group.timer = setTimeout(() => {
          delete group.timer;
          group.phase = "ready";
          void ready(
            [...group.photos].sort((a, b) => a.messageId - b.messageId),
          );
        }, 2000);
      }
      return true;
    },
    put(key: string, token: string, album: MaterialAlbum): boolean {
      const group = groups.get(key);
      if (group === undefined || group.phase !== "ready") return false;
      group.token = token;
      confirmations.set(token, { group: key, album });
      return true;
    },
    take(
      token: string,
      meetupId: string,
      telegramUserId: number,
    ): MaterialAlbum | undefined {
      const entry = confirmations.get(token);
      if (
        entry === undefined ||
        entry.album.meetupId !== meetupId ||
        entry.album.telegramUserId !== telegramUserId
      )
        return undefined;
      confirmations.delete(token);
      const group = groups.get(entry.group);
      if (group !== undefined) {
        group.phase = "confirmed";
        group.photos = [];
        delete group.token;
      }
      return entry.album;
    },
    discard(token: string, meetupId: string, telegramUserId: number): void {
      const entry = confirmations.get(token);
      if (
        entry === undefined ||
        entry.album.meetupId !== meetupId ||
        entry.album.telegramUserId !== telegramUserId
      )
        return;
      confirmations.delete(token);
      const group = groups.get(entry.group);
      if (group !== undefined) {
        group.phase = "cancelled";
        group.photos = [];
        delete group.token;
      }
    },
  };
}
