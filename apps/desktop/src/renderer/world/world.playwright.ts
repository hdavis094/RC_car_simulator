/// <reference types="node" />
/// <reference lib="dom" />
/* eslint-disable no-restricted-imports */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BUILTIN_OVAL_TRACK,
  computeCameraTransform,
  generateTrackMeshData,
  groundPointToViewportUV,
} from './index.ts';

const desktop = resolve(__dirname, '../../..');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const trackedScreenshotPath = join(__dirname, 'oval-three-cones.png');

let app: ElectronApplication;
let temp: string;
let projectDir: string;

test.beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'rcsim-world-e2e-')));
  projectDir = join(temp, 'Oval Cones Car');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  env['RCSIM_USER_DATA_DIR'] = join(temp, 'user-data');
  await mkdir(env['RCSIM_USER_DATA_DIR']);

  // Note on ANGLE / SwiftShader flags across OSes in Electron 45:
  // - Linux & Windows bundle SwiftShader (`libvk_swiftshader.so` / `vk_swiftshader.dll`) so
  //   `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` enables software WebGL on headless CI.
  // - On macOS (`process.platform === 'darwin'`), ANGLE only compiles the `metal` and `gl` backends;
  //   passing `--use-angle=swiftshader` requests a backend that is not compiled into macOS ANGLE,
  //   causing ANGLE display initialization to fail immediately even when a macOS Metal/CGL renderer is present.
  //   On macOS we pass `--ignore-gpu-blocklist` so Chromium allows software/VM GL or Metal when available.
  const launchArgs = [
    ...(process.platform === 'linux'
      ? [
          '--no-sandbox',
          process.env['DISPLAY'] ? '--ozone-platform=x11' : '--ozone-platform=headless',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]
      : process.platform === 'darwin'
        ? ['--ignore-gpu-blocklist']
        : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    desktop,
  ];

  app = await electron.launch({
    executablePath,
    env,
    args: launchArgs,
  });
});

test.afterAll(async () => {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.removeAllListeners('will-prevent-unload');
        window.webContents.on('will-prevent-unload', (event) => event.preventDefault());
      }
    });
    await app.close();
  }
  await rm(temp, { force: true, recursive: true });
});

test('renders the 3D World oval track WebGL canvas, places three cones, saves worlds/*.json, and captures a screenshot', async () => {
  const testInfo = test.info();
  const page = await app.firstWindow();

  // Set an explicit, deterministic window and viewport size (1440×900) so toolbar layout and
  // 3D viewport projection coordinates are identical across local dev and CI runners.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setContentSize(1440, 900);
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // Create a project so worlds/*.json can be saved to disk
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'New project folder' }).fill(projectDir);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main.cpp', exact: true })).toBeVisible();

  // Switch to the 3D World environment
  await page
    .getByRole('navigation', { name: 'Environments' })
    .getByRole('button', { name: '3D World' })
    .click();

  await expect(page.getByRole('heading', { name: '3D World' })).toBeVisible();
  const viewport = page.getByTestId('world-viewport');
  await expect(viewport).toBeVisible();

  // Wait for the viewport ready state to settle ('true' or 'fallback')
  await expect.poll(async () => await viewport.getAttribute('data-ready')).not.toBe('false');
  const readyState = await viewport.getAttribute('data-ready');

  // Collect Electron GPU feature status, basic GPU info, and renderer WebGL context probe diagnostics
  const gpuDiagnostics = await app.evaluate(async ({ app: electronApp }) => {
    const gpuFeatureStatus = electronApp.getGPUFeatureStatus();
    let gpuInfoBasic: unknown;
    try {
      gpuInfoBasic = await electronApp.getGPUInfo('basic');
    } catch (err) {
      gpuInfoBasic = { error: err instanceof Error ? err.message : String(err) };
    }
    return {
      platform: process.platform,
      arch: process.arch,
      gpuFeatureStatus,
      gpuInfoBasic,
    };
  });

  const rendererWebglDiagnostics = await page.evaluate(() => {
    const vp = document.querySelector('[data-testid="world-viewport"]');
    const errors: string[] = [];
    const canvas = document.createElement('canvas');
    const onErr = (event: Event): void => {
      const msg = (event as Event & { readonly statusMessage?: string }).statusMessage;
      errors.push(typeof msg === 'string' && msg.length > 0 ? msg : 'webglcontextcreationerror');
    };
    canvas.addEventListener('webglcontextcreationerror', onErr);
    const gl2 = canvas.getContext('webgl2');
    const gl1 = gl2 ? null : canvas.getContext('webgl');
    canvas.removeEventListener('webglcontextcreationerror', onErr);
    const gl = gl2 ?? gl1;
    let renderer: string | null = null;
    let vendor: string | null = null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(
        dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
      vendor = String(
        dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      );
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return {
      readyAttr: vp?.getAttribute('data-ready') ?? null,
      viewportWebglContext: vp?.getAttribute('data-webgl-context') ?? null,
      viewportWebglRenderer: vp?.getAttribute('data-webgl-renderer') ?? null,
      viewportWebglVendor: vp?.getAttribute('data-webgl-vendor') ?? null,
      viewportWebglError: vp?.getAttribute('data-webgl-error') ?? null,
      probeAvailable: Boolean(gl),
      probeRenderer: renderer,
      probeVendor: vendor,
      probeCreationErrors: errors,
    };
  });

  const diagnosticReport = JSON.stringify({ gpuDiagnostics, rendererWebglDiagnostics }, null, 2);
  console.info(`[world.playwright] GPU & WebGL diagnostics:\n${diagnosticReport}`);
  await testInfo.attach('gpu-webgl-diagnostics.json', {
    body: Buffer.from(diagnosticReport, 'utf8'),
    contentType: 'application/json',
  });

  // Read the car pose from the rendered scene rather than hard-coding it
  const carX = Number(await viewport.getAttribute('data-car-x'));
  const carZ = Number(await viewport.getAttribute('data-car-z'));
  expect(Number.isFinite(carX)).toBe(true);
  expect(Number.isFinite(carZ)).toBe(true);

  // Switch camera to top-down view, select Cone tool, and place three cones at well-separated positions
  await page.getByTestId('camera-mode-top-down').click();
  await page.getByTestId('palette-tool-cone').click();

  const pointerLayer = page.getByTestId('world-ground');

  const trackMesh = generateTrackMeshData(BUILTIN_OVAL_TRACK);
  const topDownCamera = computeCameraTransform(
    'top-down',
    { position: [carX, 0, carZ], rotation: [0, 0, 0, 1] },
    trackMesh,
  );

  // Pick three placement points around the oval track well-separated in both X and Z (>= 1.8 m apart)
  // so their markers and rotate handles never overlap at any window size.
  const targetConePositions = [
    { x: carX, z: carZ - 1.35 },
    { x: carX - 1.6, z: carZ - 2.35 },
    { x: carX, z: carZ - 3.35 },
  ] as const;

  for (let i = 0; i < targetConePositions.length; i++) {
    const pos = targetConePositions[i]!;
    const box = await pointerLayer.boundingBox();
    expect(box).not.toBeNull();
    // Verify the editor toolbar does not overlap the 3D viewport
    const toolbarBox = await page.getByTestId('world-editor-toolbar').boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(box!.y + 1);

    const aspect = box!.width / box!.height;
    const uv = groundPointToViewportUV(pos, aspect, topDownCamera);
    const clickX = box!.x + box!.width * uv.u;
    const clickY = box!.y + box!.height * uv.v;

    // Before clicking, assert via document.elementFromPoint that the target at (clickX, clickY)
    // is the interactive ground overlay ('world-ground'), not a marker, rotate handle, or toolbar control.
    const hitElementTestId = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
      { x: clickX, y: clickY },
    );
    expect(hitElementTestId).toBe('world-ground');

    await page.mouse.click(clickX, clickY);
    await expect(page.getByTestId(`obstacle-marker-cone-${i + 1}`)).toBeVisible();

    // Deselect between placements so no selected-obstacle rotate handle or controls remain active
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selected-obstacle-controls')).toHaveCount(0);
  }

  await expect(page.getByTestId('obstacle-marker-cone-1')).toBeVisible();
  await expect(page.getByTestId('obstacle-marker-cone-2')).toBeVisible();
  await expect(page.getByTestId('obstacle-marker-cone-3')).toBeVisible();

  // Switch to Orbit camera so the 3D oval track, car, and three cones are clearly visible in perspective
  await page.getByTestId('camera-mode-orbit').click();
  await page.getByTestId('palette-tool-select').click();

  // Save the world file to disk in worlds/oval-cones.json
  await page.getByTestId('world-save-btn').click();
  await expect(page.getByTestId('world-status-message')).toContainText(
    'Saved worlds/oval-cones.json',
  );

  const savedJson = JSON.parse(
    await readFile(join(projectDir, 'worlds/oval-cones.json'), 'utf8'),
  ) as {
    trackId: string;
    obstacles: Array<{ id: string; type: string; positionM: { x: number; z: number } }>;
  };
  expect(savedJson.trackId).toBe('oval');
  expect(savedJson.obstacles).toHaveLength(3);
  expect(savedJson.obstacles.map((o) => ({ id: o.id, type: o.type }))).toEqual([
    { id: 'cone-1', type: 'cone' },
    { id: 'cone-2', type: 'cone' },
    { id: 'cone-3', type: 'cone' },
  ]);
  for (let i = 0; i < targetConePositions.length; i++) {
    expect(savedJson.obstacles[i]!.positionM.x).toBeCloseTo(targetConePositions[i]!.x, 1);
    expect(savedJson.obstacles[i]!.positionM.z).toBeCloseTo(targetConePositions[i]!.z, 1);
  }

  // Check whether WebGL context creation succeeded in this environment (measured fact, not keyed on OS).
  // Evidence: On Linux, Electron bundles `libvk_swiftshader.so` and `--use-gl=angle --use-angle=swiftshader`
  // provides a working WebGL2 context (`readyState === 'true'`). On GitHub Actions `macos-latest` VMs,
  // there is no hardware GPU and if Chromium/ANGLE cannot create a WebGL context (`!rendererWebglDiagnostics.probeAvailable`
  // or `readyState === 'fallback'`), the app renders the user-facing "WebGL unavailable" fallback.
  const webglContextUnavailable =
    readyState === 'fallback' || !rendererWebglDiagnostics.probeAvailable;

  if (webglContextUnavailable) {
    const fallbackBanner = page.getByTestId('webgl-unavailable');
    await expect(fallbackBanner).toBeVisible();
    await expect(fallbackBanner).toContainText('WebGL unavailable');
    expect(errors).toEqual([]);
    test.skip(
      webglContextUnavailable,
      `Skipping WebGL canvas pixel assertions because WebGL context creation failed in this VM (readyState=${String(readyState)}, error=${String(rendererWebglDiagnostics.viewportWebglError || rendererWebglDiagnostics.probeCreationErrors.join('; ') || 'unavailable')}). Verified app launch, 3D World mount, obstacle placement, worlds/oval-cones.json save, and user-facing "WebGL unavailable" fallback.`,
    );
    return;
  }

  expect(readyState).toBe('true');

  // Wait for two animation frames so the Orbit camera frame and live marker projections are painted,
  // then sample pixels at each projected cone position and assert orange cone colour (#f97316) is present
  const canvasStats = await page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const canvas = document.querySelector(
      '[data-testid="world-viewport"] canvas',
    ) as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      return {
        hasCanvas: false,
        width: 0,
        height: 0,
        distinctColors: 0,
        coneHits: [] as Array<{ id: string; orangePixels: number; maxRed: number }>,
      };
    }

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = canvas.width;
    sampleCanvas.height = canvas.height;
    const ctx = sampleCanvas.getContext('2d');
    if (!ctx) {
      return {
        hasCanvas: true,
        width: canvas.width,
        height: canvas.height,
        distinctColors: 0,
        coneHits: [] as Array<{ id: string; orangePixels: number; maxRed: number }>,
      };
    }

    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const colors = new Set<string>();
    const stride = Math.max(1, Math.floor((width * height) / 4096)) * 4;
    for (let i = 0; i < data.length; i += stride) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
    }

    const coneIds = ['cone-1', 'cone-2', 'cone-3'];
    const coneHits: Array<{ id: string; orangePixels: number; maxRed: number }> = [];

    for (const id of coneIds) {
      const marker = document.querySelector(`[data-testid="obstacle-marker-${id}"]`);
      const u = Number(marker?.getAttribute('data-u') ?? NaN);
      const v = Number(marker?.getAttribute('data-v') ?? NaN);
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        coneHits.push({ id, orangePixels: 0, maxRed: 0 });
        continue;
      }
      const cx = Math.round(u * width);
      const cy = Math.round(v * height);
      const radius = Math.max(14, Math.round(Math.min(width, height) * 0.03));
      let orangePixels = 0;
      let maxRed = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= width) continue;
          const idx = (py * width + px) * 4;
          const r = data[idx] ?? 0;
          const g = data[idx + 1] ?? 0;
          const b = data[idx + 2] ?? 0;
          if (r > maxRed) maxRed = r;
          // Traffic cone mesh uses warm orange (#f97316 shaded by directional light): R >> G > B
          if (r > 130 && r > g + 25 && g > b + 10) {
            orangePixels++;
          }
        }
      }
      coneHits.push({ id, orangePixels, maxRed });
    }

    return {
      hasCanvas: true,
      width: canvas.width,
      height: canvas.height,
      distinctColors: colors.size,
      coneHits,
    };
  });

  expect(canvasStats.hasCanvas).toBe(true);
  expect(canvasStats.width).toBeGreaterThan(200);
  expect(canvasStats.height).toBeGreaterThan(200);
  expect(canvasStats.distinctColors).toBeGreaterThan(6);
  expect(canvasStats.coneHits).toHaveLength(3);
  for (const hit of canvasStats.coneHits) {
    expect(
      hit.orangePixels,
      `Expected warm orange cone pixels at projected screen position of ${hit.id} (maxRed=${hit.maxRed})`,
    ).toBeGreaterThan(0);
  }

  // Capture the 3D World environment element (excludes the outer app header containing the local temp path)
  const worldSection = page.getByRole('region', { name: '3D World environment' });
  const outputScreenshot = testInfo.outputPath('oval-three-cones.png');
  await worldSection.screenshot({ path: outputScreenshot });
  await testInfo.attach('oval-three-cones', {
    path: outputScreenshot,
    contentType: 'image/png',
  });

  let trackedExists: boolean;
  try {
    await access(trackedScreenshotPath, constants.F_OK);
    trackedExists = true;
  } catch {
    trackedExists = false;
  }
  if (!trackedExists || process.env['RCSIM_UPDATE_SCREENSHOT'] === '1') {
    await copyFile(outputScreenshot, trackedScreenshotPath);
  }

  expect(errors).toEqual([]);
});
