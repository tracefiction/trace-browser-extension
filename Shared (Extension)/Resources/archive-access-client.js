// Permission requests must start in the extension UI's click handler.
(() => {
  const promiseApi = typeof browser !== "undefined";
  const extension = promiseApi ? browser : chrome;
  const call = (target, method, args) => {
    try {
      if (promiseApi) return Promise.resolve(target[method](...args));
      return new Promise((resolve, reject) => target[method](...args, value => {
        if (extension.runtime.lastError) reject(new Error(extension.runtime.lastError.message));
        else resolve(value);
      }));
    } catch (error) { return Promise.reject(error); }
  };
  globalThis.TraceArchiveAccess = Object.freeze({
    read: () => call(extension.runtime, "sendMessage", [{ type: "TRACE_ARCHIVE_HOST_ACCESS_GET" }]),
    request: access => {
      // Firefox exposes no permissions API to a web-accessible extension iframe
      // embedded on an HTTP(S) page. A background message hop also loses the
      // required user gesture. Request directly in the toolbar popup click,
      // before any awaited permission, storage, or tab reads.
      const pending = call(extension.permissions, "request", [{ origins: access.origins }]);
      return pending.then(async granted => ({
        granted: granted === true,
        ...(await call(extension.runtime, "sendMessage", [{ type: "TRACE_ARCHIVE_HOST_ACCESS_REFRESH" }])),
      }));
    },
    onChanged: listener => extension.runtime.onMessage?.addListener(message => {
      if (message?.type === "TRACE_ARCHIVE_HOST_ACCESS_CHANGED") listener(message.access);
    }),
  });
})();
