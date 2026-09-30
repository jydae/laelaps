try {
  document.documentElement.dataset.theme = localStorage.getItem("laelaps.theme") || "graphite";
} catch {
  document.documentElement.dataset.theme = "graphite";
}
