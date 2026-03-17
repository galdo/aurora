const { notarize } = require('electron-notarize');
const { build } = require('../../package.json');
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function notarizeMacos(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const hasNotarizeCredentials = 'APPLE_ID' in process.env && 'APPLE_ID_PASS' in process.env;

  if (!hasNotarizeCredentials) {
    console.warn('Notarize credentials missing. Applying ad-hoc codesign for stable unsigned app bundle');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    return;
  }

  await notarize({
    appBundleId: build.appId,
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASS,
  });
};
