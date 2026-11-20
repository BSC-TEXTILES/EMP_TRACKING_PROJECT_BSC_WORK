import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { isNative } from '../lib/native';
import { captureNativeImage } from '../lib/nativeMedia';
import { Avatar } from './ui';
import { Icon } from './icons';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Square-crops and downscales large photos in the browser before upload. */
async function prepareImage(file: File): Promise<File> {
  if (!ACCEPTED.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  if (file.size === 0) throw new Error('The selected image is empty.');
  if (file.size > MAX_BYTES) throw new Error('Profile photos must be 5 MB or smaller.');
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], 'profile-photo.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function ImageUpload({
  name,
  photoUrl,
  size = 88,
  disabled,
  onUploaded,
  onRemoved,
}: {
  name: string;
  photoUrl: string | null;
  size?: number;
  disabled?: boolean;
  onUploaded: (photoUrl: string) => void | Promise<void>;
  onRemoved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return () => {
      if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const upload = async (file: File) => {
    setBusy(true);
    let localPreview: string | null = null;
    try {
      const prepared = await prepareImage(file);
      localPreview = URL.createObjectURL(file);
      setPreview(localPreview);
      const result = await api.uploadPhoto<{ photoUrl: string }>(prepared);
      setPreview(result.photoUrl);
      toast.success('Profile photo updated.');
      await onUploaded(result.photoUrl);
    } catch (caught) {
      if (localPreview) URL.revokeObjectURL(localPreview);
      setPreview(null);
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
      setDragging(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!photoUrl || !window.confirm('Remove your profile photo?')) return;
    setBusy(true);
    try {
      await api.del('/me/photo');
      setPreview(null);
      toast.success('Profile photo removed.');
      await onRemoved();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const triggerUpload = async () => {
    if (isNative) {
      const captured = await captureNativeImage('photos');
      if (captured?.blob) {
        const file = new File([captured.blob], 'photo.jpg', { type: captured.blob.type || 'image/jpeg' });
        void upload(file);
        return;
      }
    }
    inputRef.current?.click();
  };

  const shown = preview ?? photoUrl;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div
        className={dragging ? 'rounded-full ring-4 ring-brand-300' : ''}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !disabled && !busy) void upload(file);
        }}
      >
        <button
          type="button"
          className="group relative rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
          onClick={() => void triggerUpload()}
          disabled={disabled || busy}
          aria-label={shown ? 'Change profile photo' : 'Upload profile photo'}
          title={shown ? 'Change profile photo' : 'Upload profile photo'}
        >
          <Avatar name={name} src={shown} size={size} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-ink-900/55 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
            {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="camera" size={20} />}
          </span>
          {!shown && !busy && (
            <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white ring-2 ring-white">
              +
            </span>
          )}
        </button>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : shown ? 'Change photo' : 'Upload photo'}
          </button>
          {photoUrl && (
            <button type="button" className="btn-ghost btn-sm text-red-600" disabled={disabled || busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-ink-500">PNG, JPEG, WebP or GIF · up to 5 MB · square-cropped to 512 px.</p>
        <p className="mt-0.5 text-xs text-ink-400">Click or drop an image here. On mobile you can choose the camera or your gallery.</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
