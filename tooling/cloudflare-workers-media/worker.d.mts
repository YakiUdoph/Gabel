type StaticAssetsBinding = {
  fetch(request: Request): Promise<Response>;
};

export type ControlledMediaState = 'ORIGINAL_AVAILABLE' | 'ORIGINAL_REVOKED';

export function createMediaWorker(state: ControlledMediaState): {
  fetch(request: Request, env: { ASSETS: StaticAssetsBinding }): Promise<Response>;
};
