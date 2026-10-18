import { EmojiPicker } from '@/components/emoji-picker';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingCard } from '@/components/ui/loading-card';
import { Slider } from '@/components/ui/slider';
import Spinner from '@/components/ui/spinner';
import { useActiveServerId } from '@/features/app/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useServerSounds } from '@/features/server/sounds/hooks';
import { probeAudioDuration } from '@/helpers/audio-duration';
import { getFileUrl } from '@/helpers/get-file-url';
import {
  getTrpcError,
  parseTrpcErrors,
  type TTrpcErrors
} from '@/helpers/parse-trpc-errors';
import { uploadFiles } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedServerSound } from '@pulse/server/types';
import {
  SOUND_MAX_DURATION_SECONDS,
  SOUND_MAX_FILE_BYTES,
  SOUND_NAME_MAX_LENGTH,
  SOUNDS_PER_SERVER_MAX
} from '@pulse/shared';
import { Play, Plus, Trash2, Upload } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

/**
 * Server Settings → Expression → Sounds (MANAGE_SOUNDS): upload short
 * clips, name them, give them an emoji and a level, remove them. The
 * length check runs here — the browser decodes the file before the
 * upload (the server has no decoder; it enforces the byte size).
 */

const describeLimits = () =>
  `Audio up to ${Math.round(SOUND_MAX_FILE_BYTES / 1024)} KB and ${SOUND_MAX_DURATION_SECONDS} seconds; ${SOUNDS_PER_SERVER_MAX} per community.`;

type TSoundRowProps = {
  sound: TJoinedServerSound;
  selected: boolean;
  onSelect: () => void;
};

const SoundRow = memo(({ sound, selected, onSelect }: TSoundRowProps) => (
  <button
    type="button"
    onClick={onSelect}
    className={cn(
      'w-full flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer',
      selected ? 'bg-accent ring-1 ring-primary' : 'hover:bg-accent/50'
    )}
  >
    <span className="text-xl w-7 text-center" aria-hidden>
      {sound.emoji ?? '🔊'}
    </span>
    <span className="flex-1 truncate text-sm">{sound.name}</span>
    <span className="text-xs text-muted-foreground tabular-nums">{sound.volume}%</span>
  </button>
));

type TEditSoundProps = {
  sound: TJoinedServerSound;
  onClose: () => void;
};

const EditSound = memo(({ sound, onClose }: TEditSoundProps) => {
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState<string | null>(sound.emoji);
  const [volume, setVolume] = useState(sound.volume);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== sound.name || emoji !== sound.emoji || volume !== sound.volume;

  const preview = useCallback(() => {
    const audio = new Audio(getFileUrl(sound.file));
    audio.volume = volume / 100;
    audio.play().catch(() => toast.error('Could not play the preview'));
  }, [sound.file, volume]);

  const save = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setSaving(true);
    try {
      await trpc.sounds.update.mutate({
        soundId: sound.id,
        ...(name !== sound.name ? { name: name.trim() } : {}),
        ...(emoji !== sound.emoji ? { emoji } : {}),
        ...(volume !== sound.volume ? { volume } : {})
      });
      toast.success('Sound updated');
      setErrors({});
    } catch (error) {
      const parsed = parseTrpcErrors(error);
      setErrors(parsed);
      if (!parsed.name) toast.error(getTrpcError(error, 'Could not update the sound'));
    } finally {
      setSaving(false);
    }
  }, [sound, name, emoji, volume]);

  const remove = useCallback(async () => {
    const ok = await requestConfirmation({
      title: 'Delete sound',
      message: `Delete "${sound.name}"? Members will no longer be able to play it.`,
      confirmLabel: 'Delete'
    });
    if (!ok) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      await trpc.sounds.delete.mutate({ soundId: sound.id });
      toast.success('Sound deleted');
      onClose();
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not delete the sound'));
    }
  }, [sound, onClose]);

  const onEmojiSelect = useCallback((item: TEmojiItem) => {
    setEmoji(item.emoji ?? item.name);
  }, []);

  return (
    <Card className="flex-1">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Edit sound</CardTitle>
          <Button size="icon" variant="ghost" onClick={remove} aria-label="Delete sound">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
          <EmojiPicker onEmojiSelect={onEmojiSelect}>
            <Button variant="outline" size="icon" className="shrink-0 text-2xl h-14 w-14" title="Choose an emoji">
              {emoji ?? '🔊'}
            </Button>
          </EmojiPicker>
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">{sound.name}</div>
            <div className="text-xs text-muted-foreground">
              {emoji ? (
                <button type="button" className="underline cursor-pointer" onClick={() => setEmoji(null)}>
                  Remove emoji
                </button>
              ) : (
                'No emoji'
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={preview} title="Play a preview">
            <Play className="h-3.5 w-3.5 mr-1.5" />
            Preview
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sound-name">Name</Label>
          <Input
            id="sound-name"
            value={name}
            maxLength={SOUND_NAME_MAX_LENGTH}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((prev) => ({ ...prev, name: undefined }));
            }}
            placeholder="What members see in the grid"
            error={errors.name}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Volume</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{volume}%</span>
          </div>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={5}
            onValueChange={(v) => setVolume(v[0] ?? volume)}
            aria-label="Volume"
          />
          <p className="text-xs text-muted-foreground">
            The level the clip plays at for everyone; members still have their own slider per speaker.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={save} disabled={!dirty || saving || !name.trim()}>
            Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

const Sounds = memo(() => {
  const activeServerId = useActiveServerId();
  const { sounds, loading } = useServerSounds(activeServerId);
  const openFilePicker = useFilePicker();
  const [selectedId, setSelectedId] = useState<number | undefined>();
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');

  const upload = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc || !activeServerId) return;

    const files = await openFilePicker('audio/*', false).catch(() => []);
    const file = files[0];
    if (!file) return;

    if (file.size > SOUND_MAX_FILE_BYTES) {
      toast.error(`That file is ${Math.round(file.size / 1024)} KB; sounds may be at most ${Math.round(SOUND_MAX_FILE_BYTES / 1024)} KB.`);
      return;
    }

    setUploading(true);
    try {
      let seconds: number;
      try {
        seconds = await probeAudioDuration(file);
      } catch {
        toast.error('This browser cannot decode that file, so nobody could play it.');
        return;
      }
      if (seconds > SOUND_MAX_DURATION_SECONDS) {
        toast.error(`That clip is ${seconds.toFixed(1)} s long; sounds may be at most ${SOUND_MAX_DURATION_SECONDS} s.`);
        return;
      }

      const [temp] = await uploadFiles([file]);
      if (!temp) return;

      const { id } = await trpc.sounds.add.mutate({
        serverId: activeServerId,
        tempFileId: temp.id,
        name: file.name.replace(/\.[^/.]+$/, '').slice(0, SOUND_NAME_MAX_LENGTH) || 'Sound'
      });
      setSelectedId(id);
      toast.success('Sound added');
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not add the sound'));
    } finally {
      setUploading(false);
    }
  }, [activeServerId, openFilePicker]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...sounds].sort((a, b) => a.name.localeCompare(b.name));
    return q ? sorted.filter((s) => s.name.toLowerCase().includes(q)) : sorted;
  }, [sounds, search]);

  const selected = useMemo(() => sounds.find((s) => s.id === selectedId), [sounds, selectedId]);

  if (loading && sounds.length === 0) {
    return <LoadingCard className="h-[600px]" />;
  }

  const full = sounds.length >= SOUNDS_PER_SERVER_MAX;

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <Card className="w-full flex-shrink-0 md:w-80">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Sounds{' '}
              <span className="text-muted-foreground font-normal text-sm">
                {sounds.length}/{SOUNDS_PER_SERVER_MAX}
              </span>
            </CardTitle>
            <Button size="icon" variant="ghost" onClick={upload} disabled={uploading || full} title="Upload a sound">
              {uploading ? <Spinner size="xs" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          <Input
            placeholder="Search sounds..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-96 overflow-y-auto space-y-0.5">
            {visible.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {search ? 'No sounds found' : 'No sounds yet'}
              </div>
            ) : (
              visible.map((sound) => (
                <SoundRow
                  key={sound.id}
                  sound={sound}
                  selected={sound.id === selectedId}
                  onSelect={() => setSelectedId(sound.id)}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {selected ? (
        <EditSound key={selected.id} sound={selected} onClose={() => setSelectedId(undefined)} />
      ) : (
        <Card className="flex flex-1 items-center justify-center">
          <CardContent className="py-12 text-center text-muted-foreground max-w-md">
            <div className="text-4xl mb-4">🔊</div>
            <h3 className="font-medium mb-2">Soundboard</h3>
            <p className="text-sm mb-1">
              Short clips members play into voice rooms with a tap. Pick one to edit, or upload a new one.
            </p>
            <p className="text-xs mb-4">{describeLimits()}</p>
            <Button onClick={upload} disabled={uploading || full}>
              <Upload className="h-4 w-4 mr-2" />
              Upload Sound
            </Button>
            {full && (
              <p className="text-xs mt-3">This community has reached its limit; delete a sound to add another.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export { Sounds };
