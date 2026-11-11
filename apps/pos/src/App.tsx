import { useApp } from "./state/app";
import { Loading, OpenRegister, Pair, SignIn } from "./screens/Auth";
import { Pos } from "./screens/Pos";
import { ClosedScreen } from "./screens/Register";
import { UpdateRequired } from "./screens/SyncScreen";

export function App() {
  const { device, auth, sync, session, catalogue } = useApp();
  if (!device) return <Pair />;
  if (sync.updateRequired) return <UpdateRequired />;
  if (!auth || sync.authExpired) return <SignIn />;
  if (!sync.ready || !catalogue?.location) return <Loading />;
  if (!session) return <OpenRegister />;
  if (session.status === "closed") return <ClosedScreen />;
  return <Pos />;
}
