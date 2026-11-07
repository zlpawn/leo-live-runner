// Runs inside the FAST page through toString(), so it must not use anything from this module.
export function findLogOption(options, app) {
  const service = options.find((option) => option.label === app || option.label === `${app}生产环境`);
  const logs = service?.children || [];
  const log = logs.find((entry) => entry.label === '全部日志') || logs[0];
  return log ? [service.value, log.value] : null;
}

/**
 * Asks the FAST page for a service's log URL, which holds the cluster the service lives on.
 *
 * The page's iframe only shows the service it opened on, so reading it would cache another service's
 * index and silently return the wrong logs. Anything unexpected therefore learns nothing.
 *
 * Resetting version makes getKibanaUrl store the URL instead of routing away, which it does between
 * two clusters of version 7. This relies on the page's internals: if they change, the probe stops
 * learning and queries fall back to `<app>*`. settleMs stays under the extension's 8s eval limit.
 */
export function probePageScript(app, { settleMs = 5000, pollMs = 200 } = {}) {
  return `(() => {
    const find = ${findLogOption.toString()};
    const nothing = { cluster: null, index: null };
    const deadline = Date.now() + ${settleMs};
    const later = (run) => setTimeout(run, ${pollMs});
    return new Promise((resolve) => {
      const awaitUrl = (page, index) => {
        const host = (page.url || '').includes(index) && page.url.match(/\\/\\/([^/]+)/);
        if (host) return resolve({ cluster: 'https://' + host[1], index });
        if (Date.now() >= deadline) return resolve(nothing);
        later(() => awaitUrl(page, index));
      };
      const awaitOptions = () => {
        const picker = document.querySelector('.el-cascader')?.__vue__;
        const options = picker?.options || [];
        let page = picker?.$parent;
        while (page && !page.getKibanaUrl) page = page.$parent;
        // The page's own first lookup must finish, or its answer could overwrite ours.
        if (!options.length || !page?.url) {
          if (Date.now() >= deadline) return resolve(nothing);
          return later(awaitOptions);
        }
        const option = find(options, ${JSON.stringify(app)});
        if (!option) return resolve(nothing);
        page.version = 0;
        page.option = option;
        page.getKibanaUrl();
        awaitUrl(page, option[1]);
      };
      awaitOptions();
    });
  })()`;
}
