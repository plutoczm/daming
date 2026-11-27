// Keep the first paint on the user's saved theme: this runs before React and
// before the stylesheet paints, so the app never flashes light then turns dark.
(function () {
  try {
    var saved = window.localStorage.getItem('daming.theme');
    var theme = saved === 'night' || saved === 'day'
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day');
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme === 'night' ? 'dark' : 'light');
  } catch (error) {
    document.documentElement.dataset.theme = 'day';
  }
})();
