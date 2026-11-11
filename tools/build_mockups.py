"""Builds Shelfline mockups (static HTML). Icons: official Lucide via portfolio-roadmap kit.py. Run: python3 tools/build_mockups.py"""
import sys, pathlib
sys.path.insert(0, "/Users/geffaaa/Project/portfolio-roadmap/design-system/tools")
from kit import Icons

OUT = pathlib.Path(__file__).resolve().parent.parent / "mockups"
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Azeret+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">')

def page(title, body, icons, extra_css=""):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title>{FONTS}<link rel="stylesheet" href="shelfline-ds.css"><style>{extra_css}</style></head><body>'
            f'{icons.sprite()}{body}</body></html>')

DOMAINS = [("Today","layout-dashboard"),("Sell","shopping-bag"),("Stock","boxes"),("People","users"),("Money","banknote"),("Grow","megaphone")]

LOCS = [  # name, state, dot, tz, badge
    ("Fitzroy","Open · 1 register","ok","AEDT",None),
    ("South Yarra","Open · 2 registers","ok","AEDT","1 offline"),
    ("Fremantle","Open · 1 register","ok","AWST",None),
    ("Newcastle","Closed 17:31","off","AEDT",None),
    ("Dandenong DC","Warehouse · receiving","ok","AEDT",None),
]

def admin(title, domain, subnav, lens, main, ic, extra_css=""):
    tabs = "".join(f'<a href="#" {"aria-current=page" if d==domain else ""}>{ic(i)}<span>{d}</span></a>' for d,i in DOMAINS)
    mtabs = "".join(f'<a href="#" {"aria-current=page" if d==domain else ""}>{ic(i)}<span>{d}</span></a>' for d,i in DOMAINS)
    all_cur = ' aria-current="true"' if lens=="All" else ""
    locs = "".join(
        f'<a class="loc" href="#"{" aria-current=true" if n==lens else ""}><span class="dot-s {d}"></span><span class="nm">{n}</span><span class="tz">{tz}</span>'
        f'<span class="st">{s}</span>' + (f'<span class="badge">{b}</span>' if b else "") + '</a>'
        for n,s,d,tz,b in LOCS)
    sub = "".join(f'<a href="#" {"aria-current=page" if i==subnav[1] else ""}>{n}</a>' for i,n in enumerate(subnav[0]) for _ in [0]) if False else \
          "".join(f'<a href="#" {"aria-current=page" if n==subnav[1] else ""}>{n}</a>' for n in subnav[0])
    shell = f'''<div class="adm"><header class="top"><div class="brand"><span class="mk">{ic("store")}</span>Shelfline</div>
<nav class="domains" aria-label="Domains">{tabs}</nav>
<div class="tools"><div class="input" style="min-width:220px;min-height:36px">{ic("search","icon sm")}<input placeholder="Search orders, SKUs, staff" aria-label="Search"></div>
<button class="btn ghost" aria-label="Alerts">{ic("bell")}</button><button class="btn ghost" aria-label="Admin settings">{ic("settings")}</button><span class="avatar" title="Elena R., Owner">ER</span></div></header>
<div class="body"><aside class="rail" aria-label="Locations"><h2>Locations</h2>
<a class="loc all" href="#"{all_cur}><span class="dot-s"></span><span class="nm">All locations</span><span class="tz"></span><span class="st">5 locations · 5 open or receiving</span></a>
{locs}</aside>
<main class="main"><div class="lochip">{ic("map-pin","icon sm")}{lens if lens!="All" else "All locations"}{ic("chevron-down","icon sm")}</div>{main}</main></div>
<nav class="mtabs" aria-label="Domains">{mtabs}</nav></div>'''
    return page(title, shell, ic, extra_css)

def subnav_html(items, cur):
    return '<nav class="subnav" aria-label="Section">' + "".join(f'<a href="#" {"aria-current=page" if n==cur else ""}>{n}</a>' for n in items) + '</nav>'

# ------------------------------------------------------------------ S21 session
def s21():
    ic = Icons()
    date_btn = f'<button class="select" aria-haspopup="dialog" aria-expanded="false" aria-label="Business day: Tue 3 Nov 2026"><span style="display:flex;gap:8px;align-items:center">{ic("calendar","icon sm")}Tue 3 Nov 2026</span>{ic("chevron-down","icon sm")}</button>'
    ph = f'''<div class="ph"><div><h1>Registers &amp; sessions</h1><div class="sub">Fitzroy · business day closes 04:00 · all figures AUD, <span class="muted">synthetic demo data</span></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">{date_btn}<button class="btn">{ic("download","icon sm")}Export Z-report</button></div></div>'''
    sn = subnav_html(["Overview","Registers & sessions","Alerts"], "Registers & sessions")
    callout = f'''<div class="callout" role="status">{ic("triangle-alert")}<div><b>FIT-2 needs review.</b> Closed with a variance of −A$5.00 and one no-sale with no reason recorded (13:12). Three sales were made offline and synced at 11:10.</div>
<button class="btn sm" style="margin-left:auto;align-self:center">Approve variance</button></div>'''
    sess = f'''<section class="panel"><header><h2>Sessions · Tue 3 Nov</h2><span class="muted">3 sessions · 101 sales</span></header>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Session</th><th>Cashier</th><th>Opened – closed</th><th class="n">Sales</th><th class="n">Net sales</th><th class="n">Cash variance</th><th>Status</th></tr></thead><tbody>
<tr><td><b>FIT-3</b></td><td>Jun L.</td><td class="mono">12:04 – open</td><td class="n">21</td><td class="n">1,318.75</td><td class="n muted">live</td><td><span class="chip info"><span class="dot-s ok"></span>Open</span></td></tr>
<tr aria-selected="true"><td><b>FIT-2</b></td><td>Priya N.</td><td class="mono">08:57 – 17:34</td><td class="n">47</td><td class="n">4,602.00</td><td class="n neg">−5.00</td><td><span class="chip warn">{ic("triangle-alert","icon sm")}Needs review</span></td></tr>
<tr><td><b>FIT-1</b></td><td>Marcus T.</td><td class="mono">08:30 – 16:05</td><td class="n">33</td><td class="n">2,914.20</td><td class="n">0.00</td><td><span class="chip ok">{ic("check","icon sm")}Approved</span></td></tr>
</tbody></table></div></section>'''
    sheet = f'''<section class="panel"><header><h2>FIT-2 close sheet</h2><span class="chip">Priya N. · counted blind</span></header><div class="pb">
<div class="lead"><span>Opening float</span><i></i><b>300.00</b></div>
<div class="lead"><span>Cash sales <span class="muted">(31)</span></span><i></i><b>1,486.40</b></div>
<div class="lead neg"><span>Cash refunds <span class="muted">(1)</span></span><i></i><b>−89.00</b></div>
<div class="lead"><span>Pay-in · change top-up</span><i></i><b>50.00</b></div>
<div class="lead neg"><span>Pay-out · courier</span><i></i><b>−32.00</b></div>
<div class="lead neg"><span>Safe drop 13:50</span><i></i><b>−500.00</b></div>
<div class="lead total"><span>Expected in drawer</span><i></i><b>1,215.40</b></div>
<div class="lead"><span>Counted at close</span><i></i><b>1,210.40</b></div>
<div class="lead neg"><span><b>Variance</b></span><i></i><b>−5.00</b></div>
<hr class="perf">
<div class="lead"><span>Cash</span><i></i><b>1,486.40</b></div>
<div class="lead"><span>Card</span><i></i><b>3,204.55</b></div>
<div class="lead"><span>Gift card</span><i></i><b>120.00</b></div>
<div class="lead"><span>Gross sales <span class="muted">(47)</span></span><i></i><b>4,810.95</b></div>
<div class="lead neg"><span>Refunds <span class="muted">(2)</span></span><i></i><b>−208.95</b></div>
<div class="lead total"><span>Net sales</span><i></i><b>4,602.00</b></div>
<div class="lead sub"><span>GST included</span><i></i><b>418.36</b></div>
</div></section>'''
    def li(t, icon, kind, w, d=""):
        return f'<li><span class="t">{t}</span><span class="k"><span class="ic {kind}">{ic(icon)}</span></span><span class="w">{w}<div class="d">{d}</div></span></li>'
    tl = f'''<section class="panel"><header><h2>What happened</h2><span class="muted">times are Fitzroy local</span></header><div class="pb"><ul class="tl">
{li("08:49","fingerprint","ok","<b>Clocked in</b> · Priya N.","Fingerprint terminal FIT-T1")}
{li("08:57","lock-open","","<b>Register opened</b>","Float counted A$300.00 · matches standard float")}
{li("09:41","square-dashed","","<b>No sale</b>","Reason: change for customer")}
{li("11:02","wifi-off","warn","<b>Offline 7 min</b>","3 sales saved on the iPad, synced 11:10, no conflicts")}
{li("11:44","undo-2","","<b>Refund FIT2-000038</b> · A$89.00 cash","Approved by Marcus T. · item returned to Fitzroy stock")}
{li("13:12","square-dashed","danger","<b>No sale</b> · no reason recorded","Drawer opened with no sale. Alert sent to Marcus T. 13:12")}
{li("13:41","banknote","","<b>Pay-out</b> A$32.00","Courier · receipt photo attached")}
{li("13:50","download","","<b>Safe drop</b> A$500.00","Counted with Marcus T.")}
{li("17:34","lock","warn","<b>Register closed</b>","Counted A$1,210.40 · variance −A$5.00")}
</ul></div></section>'''
    main = ph + sn + callout + sess + f'<div class="split">{sheet}{tl}</div>'
    return admin("Registers & sessions · Shelfline", "Today", None, "Fitzroy", main, ic, "") if False else \
           admin("Registers & sessions · Shelfline", "Today", (["Overview","Registers & sessions","Alerts"],"Registers & sessions"), "Fitzroy", main.replace(sn,"") if False else main, ic)

# ------------------------------------------------------------------ S26 inventory
def s26():
    ic = Icons()
    ph = f'''<div class="ph"><div><h1>Inventory</h1><div class="sub">All locations · Tempra Glide 3 · Men's · <span class="muted">synthetic demo data</span></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn">{ic("arrow-right-left","icon sm")}Create transfer</button><button class="btn">{ic("clipboard-list","icon sm")}Start count</button><button class="btn primary">{ic("sliders-horizontal","icon sm")}Adjust stock at Fremantle</button></div></div>'''
    sn = subnav_html(["Products","Inventory","Purchase orders","Transfers","Stock counts","Price books"], "Inventory")
    callout = f'''<div class="callout" role="status">{ic("triangle-alert")}<div><b>Fremantle shows −1 for Men's 10.5.</b> A sale made offline synced after a cycle count removed the last pair. Resolve with a recount or an adjustment; the sale stands.</div></div>'''
    def r(size, vals, tr, sel=False):
        tot = sum(vals)
        cells = "".join(
            (f'<td class="n"><button class="neg" style="font:inherit;outline:2px solid var(--danger);outline-offset:2px;border-radius:4px;padding:0 6px">{v}</button></td>' if (sel and i==2) else
             f'<td class="n{" neg" if v<0 else ""}">{v}</td>') for i,v in enumerate(vals))
        trn = f'<td class="n"><span class="chip info">{ic("truck","icon sm")}{tr}</span></td>' if tr else '<td class="n muted">0</td>'
        return f'<tr{" aria-selected=true" if sel else ""}><td><b>Men\'s {size}</b></td>{cells}<td class="n"><b>{tot}</b></td>{trn}</tr>'
    matrix = f'''<section class="panel"><header><h2>Stock by location</h2><span class="muted">on hand · in transit counted separately</span></header>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Variant</th><th class="n">Fitzroy</th><th class="n">South Yarra</th><th class="n">Fremantle</th><th class="n">Newcastle</th><th class="n">Dandenong DC</th><th class="n">On hand</th><th class="n">In transit</th></tr></thead><tbody>
{r("9",[5,4,2,3,36],0)}{r("10",[7,5,3,2,52],0)}{r("10.5",[6,3,-1,4,48],12,True)}{r("11",[4,2,0,1,30],6)}{r("11.5",[2,1,1,0,18],0)}{r("12",[1,0,0,2,12],0)}
</tbody></table></div></section>'''
    def lr(when, kind, kcls, src, d, bal, note="", cost="—", flag=False):
        txt = (f"+{d}" if d>0 else f"\u2212{abs(d)}")
        dd = f'<td class="n" style="color:{"var(--ok)" if d>0 else "var(--danger)"};font-weight:700">{txt}</td>'
        return (f'<tr><td class="mono" style="font-size:12.5px">{when}</td><td><span class="chip {kcls}">{kind}</span></td><td>{src}</td>{dd}'
                f'<td class="n{" neg" if bal<0 else ""}"><b>{("\u2212"+str(abs(bal))) if bal<0 else bal}</b></td><td class="n">{cost}</td><td>{note}{"<span class=chip&nbsp;danger>negative stock</span>".replace("&nbsp;"," ") if flag else ""}</td></tr>')
    ledger = f'''<section class="panel"><header><div><h2>Stock card · Men's 10.5 · Black/White at Fremantle</h2><div class="muted" style="font-size:13px">SKU TG3-M-105-BW · times in Perth (AWST)</div></div><span class="chip ok">{ic("check","icon sm")}Ledger sums to balance</span></header>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Source</th><th class="n">Δ</th><th class="n">Balance</th><th class="n">Avg cost</th><th>Note</th></tr></thead><tbody>
{lr("31 Oct 16:42","sale","","FRE1-004412 · Fremantle","-1".replace("-","") and -1,-1,"Sold offline 16:42, synced 16:58 · shelf showed 1","—",True)}
{lr("31 Oct 09:10","count adjust","warn","CC-044 · cycle count",-1,0,"Counted 0 against 1 expected")}
{lr("29 Oct 12:31","sale","","FRE1-004380",-1,1)}
{lr("22 Oct 15:02","sale","","FRE1-004291",-1,2)}
{lr("17 Oct 11:48","sale","","FRE1-004233 · qty 2",-2,3)}
{lr("14 Oct 10:15","sale","","FRE1-004187",-1,5)}
{lr("08 Oct 09:30","transfer in","info","TR-0209 · from Dandenong DC",6,6,"Received 6 of 6","118.40")}
</tbody></table></div>
<div style="padding:12px 16px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap" class="muted"><span>Σ Δ = <b class="mono" style="color:var(--ink)">−1</b> · on hand <b class="mono" style="color:var(--ink)">−1</b> · checked by nightly invariant job 04:00</span><span>Cost column hidden for roles without cost access</span></div></section>'''
    main = ph + sn + callout + matrix + ledger
    return admin("Inventory · Shelfline", "Stock", (["Products","Inventory","Purchase orders","Transfers","Stock counts","Price books"],"Inventory"), "All", main.replace(sn,"") if False else main, ic)

# ------------------------------------------------------------------ S03 POS
def s03():
    ic = Icons()
    bar = f'''<nav class="pos-bar" aria-label="POS"><span class="mk">{ic("store","icon lg")}</span>
<a href="#" aria-current="page">{ic("scan-barcode")}Sell</a><a href="#">{ic("receipt")}Orders</a><a href="#">{ic("banknote")}Cash</a><a href="#">{ic("boxes")}Stock</a><a href="#">{ic("clock")}Shift</a><span class="sp"></span><a href="#">{ic("refresh-cw")}Sync<span class="bdg">3</span></a></nav>'''
    head = f'''<header class="pos-head"><div class="ctx"><div><small>Location</small><b>Fitzroy</b></div><div><small>Register</small><b>FIT-2</b></div><div><small>Cashier</small><b>Priya N.</b></div><div><small>Session</small><b class="mono">since 08:57</b></div><div><small>Tue 3 Nov</small><b class="mono">11:05</b></div></div>
<span class="sync" role="status">{ic("wifi-off")}Offline · 3 saved</span></header>'''
    def row(t, v, stk, pr, low=False):
        return f'<button class="row"><span><span class="t">{t}</span><br><span class="v">{v}</span></span><span class="stk{" low" if low else ""}"><b>{stk}</b>in stock</span><span class="pr">{pr}</span></button>'
    main = f'''<section class="pos-main">
<div class="offline-banner" role="status">{ic("wifi-off")}<div><b>You can keep selling.</b> The iPad lost Wi-Fi at 11:02. Sales are saved here and send on their own when it returns. Stock shown is as of 11:02.</div></div>
<div class="scan"><label class="input" style="flex:1">{ic("search")}<input value="glide" aria-label="Scan barcode or search products"></label><button class="btn lg" style="min-height:56px">{ic("scan-barcode")}Scan</button></div>
<div class="quick" aria-label="Quick add"><button><b>Merino tee</b><span>A$89.00</span></button><button><b>Crew socks 2-pack</b><span>A$34.00</span></button><button><b>Soft flask 500 ml</b><span>A$29.00</span></button><button><b>Run cap</b><span>A$39.00</span></button><button><b>Gift card</b><span>from A$25.00</span></button></div>
<div class="results"><div class="rh"><span>4 matches for “glide” · Fitzroy stock</span><span>Men's · Black/White</span></div>
{row("Tempra Glide 3","Men's 10 · Black/White","7","A$219.95")}
{row("Tempra Glide 3","Men's 10.5 · Black/White","6","A$219.95")}
{row("Tempra Glide 3","Men's 11 · Black/White","4","A$219.95")}
{row("Tempra Glide 3","Men's 11.5 · Black/White","2","A$219.95",True)}
</div></section>'''
    stepper = lambda q: f'<span class="stepper" role="group" aria-label="Quantity"><button aria-label="Decrease">{ic("minus","icon sm")}</button><span class="v">{q}</span><button aria-label="Increase">{ic("plus","icon sm")}</button></span>'
    cart = f'''<aside class="cart" aria-label="Current sale"><header><h2>Current sale</h2><span class="chip">4 items</span></header>
<div style="display:grid;grid-template-rows:auto 1fr;min-height:0"><div class="cust">{ic("user-round")}<div style="flex:1;line-height:1.2"><b>Sam Okafor</b><br><span class="muted" style="font-size:13px">3 visits · A$12.50 store credit</span></div><button class="btn sm ghost">Change</button></div>
<div class="lines">
<div class="line"><span><span class="t">Tempra Glide 3</span><br><span class="v">Men's 10.5 · Black/White</span></span><span class="amt">219.95</span><div class="ctl">{stepper(1)}<button class="btn sm ghost">{ic("trash-2","icon sm")}Remove</button></div></div>
<div class="line"><span><span class="t">Merino tee</span><br><span class="v">Medium · Slate</span></span><span class="amt">89.00</span><div class="ctl"><span class="disc">{ic("tag","icon sm")}10% off −8.90 · approved by Marcus T.</span>{stepper(1)}</div></div>
<div class="line"><span><span class="t">Crew socks 2-pack</span><br><span class="v">Large</span></span><span class="amt">68.00</span><div class="ctl"><span class="muted">34.00 each</span>{stepper(2)}</div></div>
</div></div>
<div class="totals"><div class="lead"><span>Subtotal</span><i></i><b>376.95</b></div><div class="lead gain"><span>Discount</span><i></i><b>−8.90</b></div><div class="lead sub"><span>GST included</span><i></i><b>33.46</b></div>
<div class="grand"><span>Total</span><b>A$368.05</b></div>
<div class="acts"><button class="btn">{ic("pause","icon sm")}Park</button><button class="btn">{ic("tag","icon sm")}Discount</button><button class="btn">{ic("square-pen","icon sm")}Note</button></div>
<button class="btn primary lg" style="width:100%;min-height:60px;font-size:20px">Pay A$368.05</button>
<div class="tender"><button class="btn">{ic("banknote","icon sm")}Cash</button><button class="btn">{ic("credit-card","icon sm")}Card</button><button class="btn disabled" aria-disabled="true" title="Needs network">{ic("lock","icon sm")}Gift card</button><button class="btn disabled" aria-disabled="true" title="Needs network">{ic("lock","icon sm")}Credit</button></div></div></aside>'''
    return page("Sell · Shelfline POS", f'<div class="pos">{bar}{head}{main}{cart}</div>', ic, ".pos-main .offline-banner{border:1px solid #EBC892;border-radius:var(--r)}.pos-main{grid-template-rows:auto auto auto 1fr}")

# ------------------------------------------------------------------ components
def comps():
    ic = Icons()
    cal_days = [(26,1),(27,1),(28,1),(29,1),(30,1),(31,1),(1,0),(2,0),(3,2),(4,3),(5,0),(6,0),(7,0),(8,0),(9,0),(10,0),(11,0),(12,0),(13,0),(14,0),(15,0),(16,0),(17,0),(18,0),(19,0),(20,0),(21,0),(22,0),(23,0),(24,0),(25,0),(26,0),(27,0),(28,0),(29,0),(30,0),(1,1),(2,1),(3,1),(4,1),(5,1),(6,1)]
    rows = ""
    for w in range(6):
        rows += "<tr>" + "".join(f'<td><button class="{"out" if f==1 else ("sel" if f==2 else ("today" if f==3 else ""))}" {"aria-selected=true" if f==2 else ""}>{d}</button></td>' for d,f in cal_days[w*7:w*7+7]) + "</tr>"
    body = f'''<div class="cmp"><div class="ph"><div><h1>Components</h1><div class="sub">Custom controls with ARIA roles. No native date, select, checkbox, radio or number inputs. Open states shown.</div></div></div>
<section><h2>Select / combobox (closed, open)</h2><div class="g">
<div class="field"><label>Location</label><button class="select" role="combobox" aria-haspopup="listbox" aria-expanded="false"><span>Fitzroy</span>{ic("chevron-down","icon sm")}</button></div>
<div class="field"><label>Reason (open)</label><button class="select" role="combobox" aria-haspopup="listbox" aria-expanded="true"><span>Damaged in store</span>{ic("chevron-down","icon sm")}</button>
<ul class="listbox" role="listbox"><li role="option">Counting error</li><li role="option" aria-selected="true">Damaged in store {ic("check","icon sm")}</li><li role="option" class="active">Supplier short-shipment</li><li role="option">Theft / shrinkage</li></ul></div></div></section>
<section><h2>Date picker (closed, open)</h2><div class="g"><div class="field"><label>Business day</label><button class="select" aria-haspopup="dialog" aria-expanded="false">{ic("calendar","icon sm")}<span style="flex:1">Tue 3 Nov 2026</span></button></div>
<div class="cal" role="dialog" aria-label="Choose a date"><header><button class="btn ghost sm" aria-label="Previous month">{ic("chevron-left","icon sm")}</button>November 2026<button class="btn ghost sm" aria-label="Next month">{ic("chevron-right","icon sm")}</button></header>
<table role="grid"><thead><tr><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th><th>Su</th></tr></thead><tbody>{rows}</tbody></table></div></div></section>
<section><h2>Checkbox, radio, switch, segmented</h2><div class="g">
<div style="display:grid;gap:4px"><button class="check" role="checkbox" aria-checked="true"><span class="box">{ic("check")}</span>Require reason for no-sale</button><button class="check" role="checkbox" aria-checked="false"><span class="box"></span>Blind count at close</button></div>
<div style="display:grid;gap:4px"><button class="radio" role="radio" aria-checked="true"><span class="dot"></span>Email PDF</button><button class="radio" role="radio" aria-checked="false"><span class="dot"></span>Send webhook</button></div>
<div style="display:grid;gap:4px"><button class="switch" role="switch" aria-checked="true"><span class="track"></span>Allow offline gift cards</button><button class="switch" role="switch" aria-checked="false"><span class="track"></span>Quiet hours</button></div>
<div class="seg" role="tablist"><button role="tab" aria-selected="true">Day</button><button role="tab" aria-selected="false">Week</button><button role="tab" aria-selected="false">Month</button></div></div></section>
<section><h2>Quantity stepper, PIN keypad, buttons, chips</h2><div class="g">
<span class="stepper"><button aria-label="Decrease">{ic("minus","icon sm")}</button><span class="v">2</span><button aria-label="Increase">{ic("plus","icon sm")}</button></span>
<div style="display:grid;gap:12px;justify-items:center"><div class="pinrow" aria-label="3 of 4 digits entered"><span class="f"></span><span class="f"></span><span class="f"></span><span></span></div><div class="keypad"><button>1</button><button>2</button><button>3</button><button>4</button><button>5</button><button>6</button><button>7</button><button>8</button><button>9</button><button aria-label="Clear">{ic("delete")}</button><button>0</button><button aria-label="Confirm" style="background:var(--volt)">{ic("check","icon lg")}</button></div></div>
<div style="display:grid;gap:8px"><button class="btn primary">Primary</button><button class="btn">Secondary</button><button class="btn ghost">Ghost</button><button class="btn disabled" aria-disabled="true">Disabled</button></div>
<div style="display:grid;gap:8px;align-content:start"><span class="chip ok">Approved</span><span class="chip warn">Needs review</span><span class="chip danger">Negative stock</span><span class="chip info">Open</span><span class="chip volt">Provisional</span></div></div></section>
<section><h2>File drop zone, text input</h2><div class="g"><div class="drop" style="min-width:320px">{ic("upload","icon lg")}<b>Drop a CSV here</b><span>or choose a file · up to 5,000 rows</span></div>
<div class="field" style="min-width:260px"><label>SKU or barcode</label><div class="input">{ic("scan-barcode","icon sm")}<input placeholder="TG3-M-105-BW" aria-label="SKU or barcode"></div></div></div></section></div>'''
    return page("Components · Shelfline", body, ic)

def index():
    ic = Icons()
    items = [("pos-sell.html","S03 · POS Sell, offline","iPad register mid-sale while Wi-Fi is down: sales save locally, stock is dated, network-only tenders say so."),
             ("admin-session.html","S21 · Registers & sessions","One register's day: dot-leader close sheet, variance, no-sale without a reason, a seven-minute offline gap."),
             ("admin-stock.html","S26 · Inventory and stock card","Variant by location matrix, stock in transit, and the stock card that sums to the balance, with a late offline sale flagged."),
             ("components.html","Components","Custom select, date picker, checkbox, radio, switch, stepper, PIN keypad, drop zone, with open states.")]
    li = "".join(f'<li style="padding:16px 0;border-bottom:1px solid var(--line)"><a href="{h}" style="font-weight:700;font-size:18px">{t}</a><div class="muted" style="margin-top:4px">{d}</div></li>' for h,t,d in items)
    body = f'<div class="cmp" style="max-width:720px"><div class="brand"><span class="mk">{ic("store")}</span>Shelfline</div><div class="ph"><div><h1>Mockups</h1><div class="sub">Static screens. Data is synthetic: Kestrel Run Co., a fictional running-shoe retailer.</div></div></div><ul style="list-style:none;margin:0;padding:0">{li}</ul></div>'
    return page("Mockups · Shelfline", body, ic)

for name, fn in [("pos-sell",s03),("admin-session",s21),("admin-stock",s26),("components",comps),("index",index)]:
    (OUT/f"{name}.html").write_text(fn()); print("wrote", name)
