import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@shelfline/ui";
import { api, hasToken, setOnUnauthorized, setToken } from "./lib/api";
import { MyReports } from "./pages/MyReports";
import { SignIn } from "./pages/SignIn";
import { Viewer } from "./pages/Viewer";

const Mark = () => <span className="mk"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 22h22" stroke="#C9E73A" strokeWidth="3.4" strokeLinecap="round" /><rect x="7" y="9" width="5" height="10" rx="1.2" fill="#fff" /><rect x="14" y="6" width="5" height="13" rx="1.2" fill="#fff" /><rect x="21" y="11" width="5" height="8" rx="1.2" fill="#fff" /></svg></span>;

function useHash() { const [h, setH] = useState(window.location.hash); useEffect(() => { const f = () => setH(window.location.hash); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []); return h; }

export function App() {
  const [signedIn, setSignedIn] = useState(hasToken()); const [me, setMe] = useState<{ name: string; email: string } | null>(null); const hash = useHash();
  useEffect(() => { setOnUnauthorized(() => setSignedIn(false)); }, []);
  useEffect(() => { if (signedIn) api<{ name: string; email: string }>("/portal/me").then(setMe).catch(() => undefined); else setMe(null); }, [signedIn]);
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;
  const [, , grantId, key] = hash.replace(/^#/, "").split("/");           // #/g/<grant>/<report>
  return (
    <div className="pt">
      <header className="pt-bar"><div className="brand"><Mark />Shelfline Reports</div><div className="who"><span className="nm">{me?.name}</span><Button size="sm" variant="ghost" onClick={() => { setToken(null); setSignedIn(false); window.location.hash = ""; }}><LogOut size={14} /> Sign out</Button></div></header>
      <main className="pt-main">{grantId && key ? <Viewer key={`${grantId}/${key}`} grantId={grantId} reportKey={key} /> : <MyReports />}</main>
    </div>
  );
}
