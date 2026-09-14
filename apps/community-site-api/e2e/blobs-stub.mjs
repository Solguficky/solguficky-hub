// Замена Netlify Blobs для E2E: те же два метода, но поверх Map в памяти.
// Настоящие Blobs потребовали бы учётной записи и сети, а проверять здесь надо
// не хранилище Netlify, а то, что страница и функция договариваются между
// собой. Подставляется хуком резолвера (`hooks.mjs`), поэтому сам обработчик
// `notes.mts` не знает о подмене и едет в тестах без единой правки.
const stores = new Map();

const open = (options = {}) => {
  const name = options.name ?? "default";
  let entries = stores.get(name);
  if (!entries) {
    entries = new Map();
    stores.set(name, entries);
  }
  return {
    // Копии, а не ссылки: настоящее хранилище отдаёт разобранный JSON, и
    // случайная правка выданного объекта не должна менять запись.
    async get(key) {
      const value = entries.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async setJSON(key, value) {
      entries.set(key, structuredClone(value));
      return { modified: true };
    },
  };
};

export const getStore = open;
export const getDeployStore = open;

/** Служебное: сброс между прогонами и порча записи для сценария отказа. */
export const testing = {
  clear: () => stores.clear(),
  put: (name, key, value) => open({ name }).setJSON(key, value),
};
