import { useEffect, useState } from 'react';
import { loadVoices } from '../lib/voice-registry';

export { setSelectedVoiceName } from '../lib/voice-registry';
export {
  cancelSpeech,
  isSpeechActive,
  setSpeechFilterMode,
  speak,
  speakConversational,
  enqueueConversational,
  markTurnComplete,
  warmupTTS,
} from '../lib/speech-session';
export type { SpeakHandle, EnqueueOptions } from '../lib/speech-session';

// ---------------------------------------------------------------------------
// useVoices - reactively exposes the synthesis voice list to React.
//
// macOS's voiceschanged event fires when the user installs/removes voices
// at runtime (e.g. they followed our guide and downloaded Voice 4). Using
// this hook in the App means the guide modal closes itself and the picker
// dropdown updates without a relaunch.
// ---------------------------------------------------------------------------

export function useVoices(): { voices: SpeechSynthesisVoice[]; ready: boolean } {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!('speechSynthesis' in window)) {
      setReady(true);
      return;
    }
    const synth = window.speechSynthesis;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const list = synth.getVoices();
      setVoices(list);
      if (list.length > 0 && !ready) setReady(true);
    };
    // Kick the lazy loader and resolve via the module-level loadVoices().
    void loadVoices().then(refresh, refresh);
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => {
      cancelled = true;
      synth.removeEventListener('voiceschanged', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { voices, ready };
}
