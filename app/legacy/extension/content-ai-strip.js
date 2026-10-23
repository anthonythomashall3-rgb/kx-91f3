// Removes AI answers from Google and Bing results while a LOCKqz quiz is active.
// Domain-level AI sites are already blocked; this hides the in-results AI panels
// (Google AI Overviews, Bing Copilot) that live on the search page itself.
(function () {
  async function active() {
    const { active_quiz } = await chrome.storage.local.get("active_quiz");
    return !!active_quiz;
  }
  const SELECTORS = [
    '[data-attrid*="AIOverview"]', '#AIOverviewContainer', 'div[aria-label*="AI Overview"]',
    'div[data-async-type="aiovr"]', '.b_cop', '#b_sydConvCont', '.b_sydconv', 'cib-serp'
  ];
  function strip() {
    SELECTORS.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));
  }
  (async () => {
    if (!(await active())) return;
    strip();
    new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true });
  })();
})();
