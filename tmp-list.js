const asar = require('@electron/asar');
const target = process.argv[2] || 'C:/Users/dbabe/AppData/Local/Programs/SallyLauncher/resources/app.asar';
const list = asar.listPackage(target).map((f) => f.split(String.fromCharCode(92)).join('/'));
console.log('total', list.length);
const filter = process.argv[3] || '/renderer';
console.log(list.filter((f) => f.startsWith(filter)).join('\n'));
