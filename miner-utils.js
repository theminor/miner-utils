'use strict';
const { connect } = require('net');
const https = require('https');

const fetchWebDta = (url, timeoutMs) => new Promise((resolve, reject) => {
	if (timeoutMs) setTimeout(() => reject('Timeout fetching ' + url), timeoutMs);
	https.get(url, resp => {
		let dta = '';
		resp.on('error', err => reject(err));
		resp.on('data', chunk => dta += chunk);
		resp.on('end', () => {
			try { resolve(JSON.parse(dta)); }
			catch (err) { resolve(dta); }
		});
	})	
});

const netCmd = (url, port, command, timeoutMs) => new Promise((resolve, reject) => {
	let socket, timeoutTimer, dataStg = '';
	const disconnectReject = function(reason) {
		if (socket.removeAllListeners) socket.removeAllListeners();
		reject(reason);
	};
	if (timeoutMs) timeoutTimer = setTimeout( () => disconnectReject('Socket timeout'), timeoutMs );
	try { socket = connect({ host: url || '127.0.0.1', port: port || 4028 }); }
	catch (err) { disconnectReject('Socket connect error: ' + err); }
	socket.on('error', err => disconnectReject('Socket net error: ' + err));
	socket.on('data', res => dataStg += res.toString());
	socket.on('end', () => {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		socket.removeAllListeners();
		try { resolve( JSON.parse(dataStg.replace(/\u0000/g, '').replace(/}{/g, '},{')) ); }
		catch (err) { resolve(dataStg); }			
	});
	socket.write(command);	
});
