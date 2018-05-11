'use strict';
const { connect } = require('net');

const netCmd = function(command, config) {
	return new Promise( (resolve, reject) => {
		let socket, timeoutTimer, dataStg = '';
		const disconnectReject = function(reason) {
			if (socket.removeAllListeners) socket.removeAllListeners();
			reject(reason);
		};
		if (config.timeOut) timeoutTimer = setTimeout( () => disconnectReject('Socket timeout'), config.timeOut );
		try { socket = connect({ host: config.ip || '127.0.0.1', port: config.port || 4028 }); }
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
