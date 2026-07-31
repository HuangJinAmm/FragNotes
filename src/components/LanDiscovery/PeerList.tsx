import type { FC } from "react";
import dayjs from "dayjs";
import type { PeerInfo } from "./types";
import { useTranslate } from "@/utils/i18n";

interface Props {
  peers: PeerInfo[];
  loading: boolean;
  selectedPeerId: string | null;
  onSelect: (peer: PeerInfo) => void;
}

const PeerList: FC<Props> = ({ peers, loading, selectedPeerId, onSelect }) => {
  const t = useTranslate();

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        <div className="bg-muted/70 rounded-lg animate-pulse h-20 w-full" />
        <div className="bg-muted/70 rounded-lg animate-pulse h-20 w-full" />
      </div>
    );
  }

  if (peers.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">{t("lan.discovery.empty")}</div>
    );
  }

  return (
    <div className="p-3 space-y-2">
      {peers.map((peer) => {
        const isSelected = peer.peer_id === selectedPeerId;
        const shortId = peer.peer_id.slice(0, 8);
        const initial = peer.display_name.trim().charAt(0).toUpperCase() || "?";
        return (
          <button
            key={peer.peer_id}
            onClick={() => onSelect(peer)}
            className={`w-full text-left p-3 rounded-lg border transition-all hover:shadow-sm ${
              isSelected
                ? "border-primary bg-accent ring-1 ring-primary/30"
                : "border-border bg-card hover:bg-accent/50"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/80 to-primary/50 text-sm font-semibold text-primary-foreground">
                {initial}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-green-500 shrink-0" />
                  <span className="font-medium truncate">{peer.display_name}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">{shortId}…</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {t("lan.memo.lastSeen")}: {dayjs.unix(peer.last_seen).format("MM-DD HH:mm")}
            </div>
          </button>
        );
      })}
    </div>
  );
};

export default PeerList;
