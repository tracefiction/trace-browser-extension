// Permission requests must start in the extension UI's click handler.
(() => {
  const promiseApi = typeof browser !== "undefined";
  const extension = promiseApi ? browser : chrome;
  let popupPort;
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
    watchPopup: () => {
      if (!/^(?:moz|chrome)-extension:\/\//.test(extension.runtime.getURL?.("") || "")) return;
      let closed = false;
      window.addEventListener("pagehide", () => { closed = true; }, { once: true });
      const connect = () => {
        if (closed) return;
        popupPort = extension.runtime.connect({ name: "trace-archive-access-popup" });
        popupPort.onDisconnect.addListener(() => {
          // Re-establish presence if a desktop background worker restarts while
          // this popup is still open. Closing the document destroys the port.
          popupPort = null;
          if (!closed) setTimeout(connect, 1000);
        });
      };
      connect();
    },
    read: () => call(extension.runtime, "sendMessage", [{ type: "TRACE_ARCHIVE_HOST_ACCESS_GET" }]),
    request: () => {
      // Firefox exposes no permissions API to a web-accessible extension iframe
      // embedded on an HTTP(S) page. A background message hop also loses the
      // required user gesture. Request directly in the toolbar popup click,
      // before any awaited permission, storage, or tab reads.
      const origins = [...new Set(extension.runtime.getManifest().host_permissions || [])];
      // The popup closes immediately after starting this native request. The
      // background's permissions.onAdded owns recovery after this UI is gone.
      return call(extension.permissions, "request", [{ origins }]);
    },
    onChanged: listener => extension.runtime.onMessage?.addListener(message => {
      if (message?.type === "TRACE_ARCHIVE_HOST_ACCESS_CHANGED") listener(message.access);
    }),
  });
})();
