import { writeFile } from 'node:fs/promises';
const slides = [
  ['stores', 'Start with your main store.', 'Connect the stores you manage to a shared stock pool.',
    'Choose the main store for starting stock|Select the inventory location in each store|See your connected stores in one group', 'group-full.jpg', 227, 356],
  ['pairing', 'Connect another store.', 'Pair your stores with a single-use code.',
    'Install the same app in each store|Enter the main store’s pairing code|Each code expires after ten minutes', 'pairing-full.jpg', 269, 198],
  ['preview', 'Review stock before syncing.', 'Match variants by SKU and inspect the proposed quantities.',
    'Preview matching tracked products|Compare main and connected-store quantities|No inventory changes during preview', 'preview-full.jpg', 291, 176],
  ['feature', 'One shared stock pool.', 'Your main store supplies the starting quantity. Stock changes can come from either store.',
    'Connect your Shopify stores|Match variants by unique SKU|Review quantities before activation', 'preview-full.jpg', 291, 176]
];
for (const [name,title,summary,features,screenshot,height,y] of slides) {
  await writeFile(`docs/listing/${name}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OnlineSync — ${name}</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1600px;height:900px;background:#f0f5f1;color:#143e31;font-family:Arial,sans-serif}main{display:grid;grid-template-columns:500px 1fr;gap:54px;padding:72px;height:900px;align-items:center}.brand{font-size:26px;font-weight:750;letter-spacing:.1em;margin-bottom:52px}h1{font-size:64px;line-height:1.06;letter-spacing:-.05em;margin:0 0 26px}p{font-size:26px;line-height:1.5;color:#486357;margin:0 0 32px}ul{padding-left:26px;font-size:22px;line-height:1.55;color:#486357}li{padding:7px 0}.shot{background:#e5eee7;border:1px solid #d6e3d9;padding:20px;border-radius:28px;box-shadow:0 24px 55px #16453415}.crop{position:relative;overflow:hidden;aspect-ratio:535/${height};border-radius:16px}.crop img{position:absolute;display:block;width:${580/535*100}%;left:${-14/535*100}%;top:${-y/height*100}%;height:auto}footer{font-size:16px;letter-spacing:.02em;margin-top:44px;color:#728779}</style></head><body><main><section><div class="brand">ONLINESYNC</div><h1>${title}</h1><p>${summary}</p><ul>${features.split('|').map(x=>`<li>${x}</li>`).join('')}</ul><footer>Firgelliauto · Inventory synchronization</footer></section><section class="shot"><div class="crop"><img src="${screenshot}" alt="OnlineSync ${name} interface on development stores"></div></section></main></body></html>`);
}
