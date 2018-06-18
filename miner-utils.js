'use strict';
const { connect } = require('net');
const https = require('https');

// fetch JSON or other data from a given url with optional timeout
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
})

// fetch JSON or other data from a given websocket with optional timeout
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
})

// take an object and a string of the path and return the value at that location (from https://stackoverflow.com/questions/42206967/getting-a-field-from-a-json-object-using-a-address-string-in-javascript)
const getValue = (obj, pathString) => pathString.replace(/\[/g, '.').replace(/\]/g, '').split('.').reduce( (obj, k) => (obj || {})[k], obj );
