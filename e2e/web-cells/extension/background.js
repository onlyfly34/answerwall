// The wall page is opened by the test. This worker only removes the header
// rule of a wall tab that was closed (the rule's id is the tab's id).
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
});
