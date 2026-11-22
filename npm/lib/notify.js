'use strict';

const { execFile } = require('node:child_process');

/** Windows PowerShell's own app id: a toast needs a registered sender, and this one exists on every Windows 10 and 11. */
const SENDER = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const quoted = text => "'" + String(text).replace(/'/g, "''") + "'";

/** The PowerShell that shows one toast. Passed encoded, so Chinese text survives the command line. */
function toastScript(title, body) {
  const toast = '<toast><visual><binding template="ToastGeneric"><text>' + xml(title) + '</text><text>' + xml(body) + '</text></binding></visual></toast>';
  return [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml(' + quoted(toast) + ')',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + quoted(SENDER) + ').Show([Windows.UI.Notifications.ToastNotification]::new($doc))',
  ].join('\n');
}

/** Shows a system notification and returns at once; a notification that cannot be shown is dropped. */
function showNotification(title, body, run = execFile) {
  if (process.platform !== 'win32') return;
  const encoded = Buffer.from(toastScript(title, body), 'utf16le').toString('base64');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 }, () => {});
}

module.exports = { showNotification, toastScript };
