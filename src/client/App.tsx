import { ActivityView } from "./ActivityView";
import { ChatView } from "./ChatView";
import { useChat } from "./use-chat";

export function App() {
  const chat = useChat();
  const path = window.location.pathname;
  const isActivity = path === "/activity" || path === "/activity/";

  if (isActivity) {
    return <ActivityView timeline={chat.timeline} ready={chat.ready} />;
  }

  return (
    <ChatView
      timeline={chat.timeline}
      running={chat.running}
      runStartedAt={chat.runStartedAt}
      queue={chat.queue}
      ready={chat.ready}
      send={chat.send}
      cancelQueued={chat.cancelQueued}
      steerQueued={chat.steerQueued}
      stop={chat.stop}
    />
  );
}
