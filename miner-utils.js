'use strict';
const { connect } = require('net');
const https = require('https');

const fetchWebDta = function (url, timeoutMs) {
	return new Promise((resolve, reject) => {
		let timeoutTimer = setTimeout(() => reject('Timeout fetching ' + url), timeoutMs || 3500);
		https.get(url, resp => {
			let dta = '';
			resp.on('data', chunk => dta += chunk);
			resp.on('end', () => {
				try { resolve(JSON.parse(dta)); }
				catch (err) { reject(err) }
			});
			resp.on('error', err => reject(err));
		})
	});
}

const netCmd = function(command, url, port, timeout) {
	return new Promise( (resolve, reject) => {
		let socket, timeoutTimer, dataStg = '';
		const disconnectReject = function(reason) {
			if (socket.removeAllListeners) socket.removeAllListeners();
			reject(reason);
		};
		if (timeout) timeoutTimer = setTimeout( () => disconnectReject('Socket timeout'), timeout );
		try { socket = connect({ host: url || '127.0.0.1', port: port || 4028 }); }
		catch (err) { disconnectReject('Socket connect error: ' + err); }
		socket.on('data', res => dataStg += res.toString());
		socket.on('error', err => disconnectReject('Socket net error: ' + err));
		socket.on('end', () => {
			socket.removeAllListeners();
			try { resolve( JSON.parse(dataStg.replace(/\u0000/g, '').replace(/}{/g, '},{')) ); }
			catch (err) { resolve(dataStg); }			
		});
		socket.write(command);
	});
};
