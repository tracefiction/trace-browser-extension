(() => {
  const site = new URL(location.href).searchParams.get("site");
  const button = document.getElementById("archive-access-allow");
  const result = document.getElementById("archive-access-result");
  let access = null;
  let requesting = false;
  const render = items => {
    access = items?.find(item => item.site === site) ?? null;
    button.disabled = requesting || !access || access.granted !== false;
    button.textContent = access?.granted === true ? "Site access allowed" : `Allow Trace on ${site === "ffn" ? "FanFiction.net" : "AO3"}`;
  };
  TraceArchiveAccess.onChanged(render);
  TraceArchiveAccess.read().then(response => render(response?.access), () => { result.textContent = "Open the Trace toolbar popup to check site access."; });
  button.addEventListener("click", () => {
    if (!access || requesting) return;
    const pending = TraceArchiveAccess.request(access);
    requesting = true;
    button.disabled = true;
    result.textContent = "";
    pending.then(response => {
      requesting = false;
      render(response.access);
      result.textContent = access?.granted === true ? "" : "Site access is still off. Try Allow again.";
    }, () => {
      requesting = false;
      render(access ? [access] : []);
      result.textContent = "Site access could not be allowed. Try again.";
    });
  });
})();
