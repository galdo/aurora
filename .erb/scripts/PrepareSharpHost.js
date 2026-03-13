const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(projectRoot, 'src');

const platform = process.platform;
const arch = process.arch;

const packageMap = {
  darwin: {
    arm64: ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
    x64: ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64'],
  },
  win32: {
    arm64: ['@img/sharp-win32-arm64', '@img/sharp-libvips-win32-arm64'],
    ia32: ['@img/sharp-win32-ia32', '@img/sharp-libvips-win32-ia32'],
    x64: ['@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64'],
  },
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function sharpLoadsForHost() {
  try {
    const sharpPath = require.resolve('sharp', {
      paths: [srcDir],
    });
    const loadModule = new Function('modulePath', 'return require(modulePath);');
    loadModule(sharpPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function installSharpForHost() {
  const platformPackages = packageMap[platform] || {};
  const hostPackages = platformPackages[arch] || [];
  if (hostPackages.length === 0) {
    return;
  }

  const args = [
    '--prefix',
    'src',
    'install',
    '--no-save',
    '--include=optional',
    '--force',
    `--os=${platform}`,
    `--cpu=${arch}`,
    'sharp',
    ...hostPackages,
  ];
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

if (!sharpLoadsForHost()) {
  installSharpForHost();
}
