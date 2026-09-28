import type { Location, Memo, Visibility } from "@/types/proto/api/v1/memo_service_pb";
import type { AudioRecorderStatus } from "../hooks/useAudioRecorder";
import type { LocalFile } from "./attachment";

export interface MemoEditorProps {
  className?: string;
  cacheKey?: string;
  placeholder?: string;
  /** Existing memo to edit. When provided, the editor initializes from it without fetching. */
  memo?: Memo;
  parentMemoName?: string;
  autoFocus?: boolean;
  /**
   * Default `createTime` for a *new* memo (create mode only). When set, the
   * editor seeds both `createTime` and `updateTime` to this value and renders
   * the timestamp popover so the user can adjust before saving. Tracked live:
   * if the prop changes after mount, the editor's timestamps re-sync. Ignored
   * in edit mode (when `memo` is set).
   */
  defaultCreateTime?: Date;
  /**
   * Mount the editor already in focus mode. Used by callers that open the
   * composer on demand as a standalone capture window (e.g. Home's floating
   * 「记笔记」button) rather than keeping it inline in the page.
   */
  initialFocusMode?: boolean;
  /**
   * Called after focus mode is left — via the exit button, the backdrop, the
   * insert menu toggle, or the editor reset that follows a successful save.
   * Callers that mounted the editor with `initialFocusMode` use this to
   * unmount it and fall back to their own trigger.
   */
  onFocusModeExit?: () => void;
  onConfirm?: (memoName: string) => void;
  onCancel?: () => void;
}

export interface EditorContentProps {
  placeholder?: string;
  /** Invoked by the in-editor save shortcut (Cmd/Ctrl+Enter). */
  onSubmit: () => void;
  /** Called when a file is added via drag-drop or paste. If omitted, falls
   *  back to dispatching addLocalFile directly. */
  onFileAdded?: (file: LocalFile) => void;
}

export interface EditorToolbarProps {
  onSave: () => void;
  onCancel?: () => void;
  memoName?: string;
  onAudioRecorderClick: () => void;
  /** Whether the formatting toolbar is shown in normal mode (persisted preference). */
  isFormattingToolbarVisible: boolean;
  onToggleFormattingToolbar: () => void;
  /** Whether auto-tag extraction is enabled (persisted preference). */
  autoTagEnabled: boolean;
  onToggleAutoTag: () => void;
  /** Whether document-summary is enabled (persisted preference). */
  summaryEnabled: boolean;
  onToggleSummary: () => void;
  /** Passed through to InsertMenu for file-add interception. */
  onFileAdded?: (file: LocalFile) => void;
}

export interface EditorMetadataProps {
  memoName?: string;
}

export interface AudioRecorderPanelProps {
  audioRecorder: { status: AudioRecorderStatus; elapsedSeconds: number };
  /** Active mic stream while recording; used for live waveform visualization. */
  mediaStream: MediaStream | null;
  onStop: () => void;
  onCancel: () => void;
  onTranscribe?: () => void;
  canTranscribe?: boolean;
  isTranscribing?: boolean;
}

export interface FocusModeOverlayProps {
  isActive: boolean;
  onToggle: () => void;
}

export interface FocusModeExitButtonProps {
  isActive: boolean;
  onToggle: () => void;
  title: string;
}

export interface InsertMenuProps {
  isUploading?: boolean;
  location?: Location;
  onLocationChange: (location?: Location) => void;
  onToggleFocusMode?: () => void;
  memoName?: string;
  onAudioRecorderClick?: () => void;
  /** Persisted toggle for the normal-mode formatting toolbar. */
  isFormattingToolbarVisible?: boolean;
  onToggleFormattingToolbar?: () => void;
  /** Called when a file is added via the file input. If omitted, falls back
   *  to dispatching addLocalFile directly. */
  onFileAdded?: (file: LocalFile) => void;
}

export interface VisibilitySelectorProps {
  value: Visibility;
  onChange: (visibility: Visibility) => void;
  onOpenChange?: (open: boolean) => void;
}
