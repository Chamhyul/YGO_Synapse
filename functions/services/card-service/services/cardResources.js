// 카드 자원 metadata 계약. 사용자 DB·인벤토리에는 접근하지 않는다.
function createCardResourcesReader({ getBucket, getStorageEmulatorBaseUrl, isEmulator }) {
  return async function readCardResources() {
    const bucket = getBucket();
    const getResource = async (path, format) => {
      const file = bucket.file(path);
      try {
        const [metadata] = await file.getMetadata();
        const url = isEmulator()
          ? `${getStorageEmulatorBaseUrl()}/download/storage/v1/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`
          : `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
        return { available: true, url, updatedAt: new Date(metadata.updated).getTime(),
          generation: String(metadata.generation), format };
      } catch (error) {
        if (Number(error.code) !== 404) console.warn(`[Sync] ${path} metadata error:`, error.message);
        return { available: false, url: null, updatedAt: 0, generation: null, format };
      }
    };

    const [cardManifest, packs, rarity] = await Promise.all([
      getResource("public/cardNames.json", "card-manifest-v2"),
      getResource("public/packs.json", "packs-v1"),
      getResource("public/rarityMapping.json", "rarity-langs-v1"),
    ]);

    return { cardManifest, packs, rarity };
  };
}
module.exports = { createCardResourcesReader };
