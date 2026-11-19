import { lazy, Suspense } from "react";
import { ChatView } from "./ChatView";
import { useChat } from "./use-chat";

const EventsView = lazy(() => import("./EventsView").then((m) => ({ default: m.EventsView })));
const ShaderBackground = lazy(() =>
  import("./ShaderBackground").then((m) => ({ default: m.ShaderBackground })),
);

function currentPath(): string {
  const path = window.location.pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

export function App() {
  const path = currentPath();
  const detailPage = path === "/activity" || path === "/events";

  const chat = useChat({ fullHistory: detailPage });

  let view = (
    <ChatView
      timeline={chat.timeline}
      running={chat.running}
      quiet={chat.quiet}
      thinking={chat.thinking}
      interrupted={chat.interrupted}
      runError={chat.runError}
      dismissRunError={chat.dismissRunError}
      delegates={chat.delegates}
      jobs={chat.jobs}
      ready={chat.ready}
      tasks={chat.tasks}
      planning={chat.planning}
      taskActivity={chat.taskActivity}
      send={chat.send}
      stop={chat.stop}
      unsendSteer={chat.unsendSteer}
      cancelQueued={chat.cancelQueued}
      pendingSteers={chat.steers.filter((steer) => steer.dropped === undefined).length}
      applyTasks={chat.applyTasks}
      stats={{
        usage: chat.usage,
        context: chat.context,
        mcp: chat.mcp,
        mcpEvents: chat.mcpEvents,
      }}
      refreshStats={chat.refresh}
      history={{
        hasEarlier: chat.hasEarlier,
        loading: chat.loadingEarlier,
        loadEarlier: chat.loadEarlier,
      }}
    />
  );

  if (path === "/events") {
    view = <EventsView events={chat.mcpEvents} ready={chat.ready} status={chat.mcp} />;
  }

  return (
    <>
      <div data-testid="safe-area-blocker" aria-hidden="true" className="safe-area-blocker" />
      <Suspense fallback={null}>
        <ShaderBackground />
      </Suspense>
      <div className="relative z-10 h-full">
        <Suspense fallback={null}>{view}</Suspense>
      </div>
    </>
  );
}
