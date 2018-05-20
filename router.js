'use strict';
const { promisify } = require('util');
const fs = require('fs');
const readFileAsync = promisify(fs.readFile);

class Server {
	constructor(port, urlBase, useHttps, sslKeyPath, sslCertPath, useAuthentication, authUserName, authPassword, defaultSendFile, postFunction) {
		let http, serverOptions;
		const self = this;

		self.port = port || 45474;
		self.urlBase = urlBase || '/';
		self.useAuthentication = useAuthentication || false;
		self.authUserName = authUserName || 'user';
		self.authPassword = authPassword || 'secret';
		self.defaultSendFile = defaultSendFile || './success.txt';
		if (useHttps) {
			http = require('https');
			serverOptions = {
				key: fs.readFileSync(sslKeyPath),
				cert: fs.readFileSync(sslCertPath)
			};
		} else http = require('http');
		self.cache = {};

		self.srv = http.createServer(serverOptions, (req, res) => {
			function sendError(errCode, msg, err) {
				console.warn('Error code ' + errCode + ': ' + msg + '. ' + err);
				res.statusCode = errCode;
				res.writeHead(errCode, msg);
				return res.end(errCode + ' ' + msg);
			}
			async function sendStatic(file, contentType) {
				if (!contentType) {
					contentType = 'text/plain';
					if (file.endsWith('.js')) contentType = 'text/javascript';
					else if (file.endsWith('.css')) contentType = 'text/css';
					else if (file.endsWith('.json')) contentType = 'application/json';
					else if (file.endsWith('.png')) contentType = 'image/png';
					else if (file.endsWith('.html')) contentType = 'text/html';
				}
				if (!self.cache[file]) {
					try {
						self.cache[file] = await readFileAsync(file, { encoding: 'utf8' });
					} catch (err) {
						self.cache[file] = null;
						return sendError(404, 'File not found: ' + file, err);
					}
				}
				res.statusCode = 200;
				res.writeHead(200, { 'Content-Type': contentType });
				res.end(self.cache[file], 'utf-8');
			}
			function sendLogin() {
				res.statusCode = 401;
				res.setHeader('WWW-Authenticate', 'Basic realm="yanta"');
				return res.end('Login Required');
			}

			let auth = req.headers['authorization'];
			if (auth) {
				let [usr, pswd] = new Buffer(auth.replace('Basic ', ''), 'base64').toString('utf8').split(':'); // remove 'Basic ', then convert to base 64, then split "username:password"
				if (usr === self.authUserName && pswd === self.authUserPassword) {
					let path = '.' + req.url.replace(srvSettings.urlBase, '');
					if (req.method === 'GET') {
						if (path === '.' || path === './') return sendStatic('./index.html');
						else return sendStatic(path);
					} else if (req.method === 'POST' || req.method === 'PUT') {
						cache[path] = null;
						let dta = '';
						req.on('error', err => sendError(500, 'Error in PUT ' + path, err));
						req.on('data', chunk => (dta += chunk));
						req.on('end', async () => {
							if (req.method === 'PUT') {
								fs.writeFile(path, dta, err => {
									if (err) return sendError(507, 'PUT Error writing file: ' + path, err);
									else return sendStatic(self.defaultSendFile);
								});
							} else {
								self.postData = dta; // POST method
								if (self.postFunction) await self.postFunction(dta);
								return sendStatic(path);
							}
						});
					} else if (req.method === 'DELETE') {
						fs.unlink(path, err => {
							if (err) return sendError(500, 'DELETE Error deleting file: ' + path, err);
							else return sendStatic(self.defaultSendFile);
						});
					} else return sendError(400, 'No request method specified', '400');
				} else return setTimeout(sendLogin, 3000); // Repeated login attempt - delay by 3 seconds for security
			} else sendLogin(); // Initial authentication is needed
		});
		self.srv.listen(self.port);
	}
}

module.exports = Server;
