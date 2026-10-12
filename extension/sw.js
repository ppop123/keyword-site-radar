// 点工具栏图标直接打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// 「找站」在后台开的 sim 标签页：侧边栏被关掉（连接断开）时替它关掉；用户切过去在看的不关
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  let tab = null;
  port.onMessage.addListener((m) => { tab = m.refTab ?? null; });
  port.onDisconnect.addListener(() => {
    if (tab == null) return;
    const id = tab;
    chrome.tabs.get(id).then((t) => { if (!t.active) return chrome.tabs.remove(id); }).catch(() => {});
    chrome.storage.local.remove('stripe-ref-tab').catch(() => {});
  });
});
