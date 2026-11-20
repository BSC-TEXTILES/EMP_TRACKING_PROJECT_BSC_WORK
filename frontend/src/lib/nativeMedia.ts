import { isNative } from './native';

export interface NativePhotoResult {
  dataUrl?: string;
  format?: string;
  base64String?: string;
  blob?: Blob;
}

/**
 * Captures a photo using the device camera or picks an image from the photo gallery on Android/iOS.
 * Returns a dataUrl or Blob ready for upload.
 */
export async function captureNativeImage(source: 'camera' | 'photos' = 'camera'): Promise<NativePhotoResult | null> {
  if (!isNative) return null;

  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');

    const photo = await Camera.getPhoto({
      quality: 85,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source: source === 'photos' ? CameraSource.Photos : CameraSource.Camera,
    });

    if (!photo.dataUrl) return null;

    // Convert dataUrl to Blob if needed
    const res = await fetch(photo.dataUrl);
    const blob = await res.blob();

    return {
      dataUrl: photo.dataUrl,
      format: photo.format,
      blob,
    };
  } catch (error) {
    console.warn('[NativeMedia] Camera capture cancelled or failed:', error);
    return null;
  }
}

/**
 * Downloads a file to native device storage and opens it in system viewer or browser
 */
export async function saveAndOpenNativeFile(url: string, filename: string): Promise<boolean> {
  if (!isNative) {
    window.open(url, '_blank');
    return true;
  }

  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Browser } = await import('@capacitor/browser');

    // Fetch blob
    const response = await fetch(url);
    const blob = await response.blob();

    // Convert blob to base64
    const base64Data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const res = reader.result as string;
        resolve(res.split(',')[1] || res);
      };
      reader.readAsDataURL(blob);
    });

    const saved = await Filesystem.writeFile({
      path: filename,
      data: base64Data,
      directory: Directory.Cache,
    });

    await Browser.open({ url: saved.uri });
    return true;
  } catch (error) {
    console.warn('[NativeMedia] Save/Open file fallback to browser:', error);
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return true;
    } catch {
      return false;
    }
  }
}
