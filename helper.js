// ISOLATED world — has host_permissions for cross-origin fetches.
// Watches for fetch requests from the MAIN world via DOM elements.
// MAIN world creates #tvc-fetch-request with data-url; this script fetches
// and writes the result back to the same element's data-csv and data-status.

async function waitForBody() {
  while (!document.body) {
    await new Promise(r => requestAnimationFrame(r));
  }
}

async function handleFetchRequest(el) {
  try {
    const response = await fetch(el.dataset.url);
    const text = await response.text();
    el.dataset.csv = text;
    el.dataset.status = 'ok';
  } catch (e) {
    el.dataset.csv = '';
    el.dataset.status = 'error';
    console.log('Tool vs Chat helper: fetch failed', e);
  }
}

async function init() {
  await waitForBody();

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.id === 'tvc-fetch-request' && node.dataset.url && !node.dataset.status) {
          handleFetchRequest(node);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true });
}

init();
