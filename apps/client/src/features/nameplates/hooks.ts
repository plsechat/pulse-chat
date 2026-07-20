import type { IRootState } from '@/features/store';
import { useSelector } from 'react-redux';

export const useNameplatePacks = () =>
  useSelector((state: IRootState) => state.nameplates.packs);

export const useNameplatePacksLoaded = () =>
  useSelector((state: IRootState) => state.nameplates.loaded);
