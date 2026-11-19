// MediaPipe Face Landmarker; wasm и модель отдаём со своего сайта (относительные пути).
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface Landmarker {
  lm: FaceLandmarker;
  delegate: 'GPU' | 'CPU';
}

export async function createLandmarker(): Promise<Landmarker> {
  const fileset = await FilesetResolver.forVisionTasks('./wasm');
  const make = (delegate: 'GPU' | 'CPU') =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 2,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
  try {
    return { lm: await make('GPU'), delegate: 'GPU' };
  } catch (e) {
    console.warn('GPU-делегат недоступен, переключаюсь на CPU', e);
    return { lm: await make('CPU'), delegate: 'CPU' };
  }
}
