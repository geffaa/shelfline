import { chromium } from '/Users/geffaaa/Project/jaga/node_modules/playwright/index.mjs';
const b = await chromium.launch({ channel: 'chrome' });
const pages = ['pos-sell','admin-session','admin-stock','components','index'];
for (const [w,h,tag] of [[1440,900,'d'],[390,844,'m']]) {
  const ctx = await b.newContext({ viewport:{width: (tag==='d'? 1440:390), height:h}});
  for (const p of pages) {
    const pg = await ctx.newPage();
    const vw = (p==='pos-sell' && tag==='d') ? 1180 : w; await pg.setViewportSize({width:vw,height:(p==='pos-sell'&&tag==='d')?820:h});
    await pg.goto('file:///Users/geffaaa/Project/shelfline/mockups/'+p+'.html'); await pg.waitForTimeout(900);
    const sw = await pg.evaluate(()=>document.documentElement.scrollWidth - innerWidth);
    console.log(p,tag,'hscroll',sw);
    await pg.screenshot({path:`.impeccable/review/${p}-${tag}.png`, fullPage: p!=='pos-sell'||tag==='m'});
    await pg.close();
  }
}
await b.close();
