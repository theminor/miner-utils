'use strict';

const { promisify } = require('util');
const net = require('net');
const connectAsync = promisify(net.connect);

const cgCmd = async function(command, config) {
	var socket;
	var dataStg = '';
	try {
		socket = await connectAsync({ host: config.ip, port: config.port });
	} catch (err) {
		return node.error('Error in net socket connection: ' + err);
	}
	socket.on('data', res => (dataStg += res.toString()));
	socket.on('end', () => {
		socket.removeAllListeners();
		try {
			return JSON.parse(
				dataStg.replace(/\u0000/g, '').replace(/}{/g, '},{')
			);
		} catch (err) {
			node.warn('Error parsing json: ' + err);
			return dataStg;
		}
	});
	socket.on('error', err => {
		socket.removeAllListeners();
		return node.error('Net socket error: ' + err);
	});
};
