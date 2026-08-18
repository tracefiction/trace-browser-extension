(() => {
  const badgeId = "trace-permission-spike-proof";
  if (document.getElementById(badgeId)) return;

  const badge = document.createElement("div");
  badge.id = badgeId;
  badge.textContent = `Trace permission probe active on ${location.hostname}`;
  badge.setAttribute("role", "status");
  Object.assign(badge.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    maxWidth: "calc(100vw - 24px)",
    padding: "10px 12px",
    borderRadius: "10px",
    background: "#173d33",
    color: "#ffffff",
    font: "600 12px/1.35 -apple-system, BlinkMacSystemFont, sans-serif",
    boxShadow: "0 6px 24px rgba(0, 0, 0, 0.24)",
  });
  document.documentElement.appendChild(badge);
})();
