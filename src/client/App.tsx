import { lazy, Suspense } from "react";
import { ChatView } from "./ChatView";
import { useChat } from "./use-chat";

// Everything off the chat's first paint loads in its own chunk.
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
  // The activity and events pages read the whole conversation; the chat starts from its end.
  const chat = useChat({ fullHistory: detailPage });

  let view = (
    <ChatView
      timeline={chat.timeline}
      running={chat.running}
      thinking={chat.thinking}
      interrupted={chat.interrupted}
      ready={chat.ready}
      tasks={chat.tasks}
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
    view = <EventsView events={chat.mcpEvents} ready={chat.ready} />;
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
