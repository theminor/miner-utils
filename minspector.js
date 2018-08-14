'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { connect } = require('net');
const WebSocket = require('ws');
const mqtt = require('async-mqtt');
const settings = require('./settings.json');

// *** TO DO: ***
//	- [X]	Add history and graphs to html page
//		- [ ]	Make chart points based on time, not necessarily last x points (or make the algorythm that saves data history hit only over time?)
//		- [ ]	Better chart styling
//		- [ ]	Expand data history - more time/points; make based on settings


/**
 * Log an Error Message; Optionally simplify the output
 * @param {Error} err - an error Object that was thrown
 * @param {String} [seperator=" --> "] - a string used to seperate parts of the error ourput
 * @param {String} [preMessage="\n***${date}***"] - a string that is prepended to each error message
 * @param {Boolean | String} [simplify] - if true, the output will be shortened and will not include the lengthy stack trace data; if a String is recieved for the simplify parameter, the error message will be replaced with the String; if the err Object includes a custom "simpleMessage" property (whether or not the simplify paramter is true), the simpleMessage property will be used without lengthy trace info
 */
function logErr(err, seperator, preMessage, simplify) {
	if (!seperator) seperator = ' --> ';
	if (!preMessage) preMessage = '\n*** ' + new Date().toLocaleString() + ' ***  ';
	if (simplify && typeof(simplify) === 'string') console.warn(preMessage + simplify);
	else if (err.simpleMessage) console.warn(preMessage + err.simpleMessage);
	else console.warn(preMessage + err.message + (simplify ? '' : seperator + err.stack));
}

/**
 * Send an email using sendgrid.com; settings from settings object
 * @param {String} message - the email message body  
 * @param {String} [subject=settings.notifications.sendgrid.defaultSubject] - the email subject
 * @returns {Promise} response object from the POST request to sendgrid
 */
function sendGridNotification (message, subject) {
	return new Promise((resolve, reject) => {
		console.log('Sending sendgrid notification: ' + message);
		let req = https.request(settings.notifications.sendgrid.requestOptions, response => {
			if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
			else reject('sendgrid notification for message "' + message + '" failed to return a successful status code (returned status code ' + res.statusCode + ').');
		});
		req.on('error', (err) => { err.message = 'Error in sendGridNotification(): ' + err.message; reject(err); });
		req.on('timeout', () => { reject('Timeout in sendGridNotification()'); })
		req.end(JSON.stringify({
			"personalizations": [{"to": [{ "email": settings.notifications.sendgrid.emailTo }]}],
			"from": {"email": settings.notifications.sendgrid.emailFrom},
			"subject": subject || settings.notifications.sendgrid.defaultSubject,
			"content": [{
				"type": "text/plain",
				"value": message || settings.notifications.sendgrid.defaultMessage
			}]
		}));
	})
}

/**
 * Send a notification, if suffecient frequency has elapsed
 * @param {Object} notification - a notification object from settings 
 */
async function sendNotification(notification) {
	if ((!notification.lastSendDate) || ((notification.lastSendDate - new Date()) >= notification.frequencyMS)) {
		try {
			if (notification.type === 'sendgrid') await sendGridNotification(notification.message, notification.subject);
			// else if (notification.type === 'push') {}
			// etc.
			notification.lastSendDate = new Date();		// should only reach here if success. If error, catch should hit before lastSendDate gets updated.
		} catch (err) { err.message = 'Error in sendNotification, notification type ' + notification.type + ': ' + err.message; logErr(err); }
	}
}

/**
 * Reset all notification timers
 */
function resetNotifications() {
	for (const pointName of Object.keys(settings.endPoints)) {
		for (const vblDtaPt of Object.keys(pointName.variableData)) {
			if (vblDtaPt.notification) vblDtaPt.notification.lastSendDate = null;
		}
	}
}

/**
 * Copy the current data from lastdata[key] to the point.datahistory[key] array
 * @param {Object} point - the point to act on
 * @param {String} key - the name of the key on the datapoint
 */
function copyLastDataToHistory(point, key) {
	if (!point.dataHistory) point.dataHistory = {};
	if (!point.dataHistory[key]) point.dataHistory[key] = [];
	if (point.dataHistory[key].length >= settings.server.keepHistory) point.dataHistory[key].shift();
	let time = new Date();
	let hr = time.getHours();
	let min = time.getMinutes();
	if (hr > 12) hr = hr - 12;
	if (min < 10) min = '0' + min.toString();
	point.dataHistory[key].push({"time": hr.toString() + ':' + min.toString(), "data": point.lastData[key]});
}

/**
 * Fetch JSON or other data from a given url and return the result (as a promise)
 * @param {string} url - the url to fetch
 * @param {number} [timeoutMs] - milliseconds to wait before timing out. If not specified, will not timeout.
 * @param {string} [name] - short name of the website from which to fetch (for error handling only)
 * @returns {Promise} Returned data from the url. If JSON was returned, it will be parsed into an Object. Otherwise, as a string.
 */
 function fetchWebDta (url, timeoutMs, name) {
	return new Promise((resolve, reject) => {
		if (timeoutMs) setTimeout(() => {
			let err = new Error('Error in fetchWebDta(): Timeout fetching ' + url);
			err.simpleMessage = 'fetchWebDta(): timeout fetching from ' + (name || '-unspecified-');
			reject(err);
		}, timeoutMs);
		https.get(url, resp => {
			let dta = '';
			resp.on('error', err => { err.message = 'Error in fetchWebDta(' + url + '): ' + err.message; reject(err); });
			resp.on('data', chunk => dta += chunk);
			resp.on('end', () => {
				try { resolve(JSON.parse(dta)); }
				catch (err) { resolve(dta); }
			});
		})
	})
}

/**
 * Fetch JSON or other data from a given socket and return the result (as a promise)
 * @param {string} url - the url to fetch
 * @param {number} port - the port to connect to
 * @param {string} command - the string to write to the socket to initiate the connection
 * @param {number} [timeoutMs] - milliseconds to wait before timing out. If not specified, will not timeout.
 * @returns {Promise} Returned data. If JSON was returned, it will be parsed into an Object. Otherwise, as a string.
 */
function fetchSocket(url, port, command, timeoutMs) {
	return new Promise((resolve, reject) => {
		let socket, timeoutTimer, dataStg = '';
		const disconnectReject = function(err) {
			if (socket.removeAllListeners) socket.removeAllListeners();
			reject(err);
		};
		if (timeoutMs) timeoutTimer = setTimeout( () => disconnectReject('Socket timeout'), timeoutMs );
		try { socket = connect({ host: url || '127.0.0.1', port: port || 4028 }); }
		catch (err) { err.message = 'fetchSocket() Socket connect error: ' + err.message; disconnectReject(err); }
		socket.on('error', err => { err.message = 'fetchSocket() Socket net error: ' + err.message; disconnectReject(err); });
		socket.on('data', res => dataStg += res.toString());
		socket.on('end', () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			socket.removeAllListeners();
			try { resolve( JSON.parse(dataStg.replace(/\u0000/g, '').replace(/}{/g, '},{')) ); }
			catch (err) { resolve(dataStg); }
		});
		socket.write(command);
	})
}

/**
 * Send a data point on the given websocket
 * @param {Object} [ws] - the websocket object. If not specified, nothing is sent
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients on tick)
 * @param {Object} point - the point to send
 * @param {String} errMsg - pre-error message to identify errors by
 */
function wsSendPoint(ws, wss, point, errMsg) {
	if (wss) wss.clients.forEach(ws => wsSendPoint(ws, null, point, 'From wsSendPoint(): '));
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(point, (k, v) => (k === 'mqttClient' || k === 'timer') ? undefined : v), err => { if (err) { err.message = 'Websocket Send Error: ' + errMsg + ': ' + err.message; logErr(err); } });
}

/**
 * Set up an MQTT Point
 * @param {Object} point - the point containing mqtt setup information
 * @param {Object} [ws] - the websocket on which to send data
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients on tick)
 * @returns {Promise} Returned data. If JSON was returned, it will be parsed into an Object. Otherwise, as a string.
 */
function setupMqtt(point, ws, wss) {
	return new Promise((resolve, reject) => {
		try {
			if (!point.lastData)  {
				point.mqttClient = mqtt.connect(point.mqtt.url, point.mqtt.options);
				point.lastData = {};
				point.mqttClient.on('connect', () => point.mqttClient.subscribe(point.mqtt.subscriptionTopic + '#') );
				point.mqttClient.on('message', (topic, message) => {
					let tpc = topic.replace(point.mqtt.subscriptionTopic, '');
					if (point.variableData[tpc]) {
						point.lastData[tpc] = (Number(message.toString()) * (point.variableData[tpc].multiplier || 1)) + (point.variableData[tpc].offset || 0);
						copyLastDataToHistory(point, tpc);
					}
					wsSendPoint(ws, wss, point, 'From setupMqtt() - topic: ' + topic + ', message: ' + message + ', ');
				});
			}
			point.mqttClient.publish(point.mqtt.forceUpdateTopic, point.mqtt.forceUpdateMessage);
			resolve(point);
		} catch (err) { err.message = 'Error in setupMqtt(' + point.name + '): ' + err.message; reject(err); }
	});
}

/**
 * Return the value of a deep Object location given as a string referenceing that location (see https://stackoverflow.com/questions/42206967/getting-a-field-from-a-json-object-using-a-address-string-in-javascript)
 * @param {Object} obj - the object to analyze
 * @param {string} pathString - a string referencing the path to the deep object wanted to return
 * @returns {Object} the referenced item
 * @example
 * // returns "hi"
 * getValue({foo:{x:0,data:[bar:"hi", baz:"no"]}}, foo.data[0].bar);
 */
function getValue(obj, pathString) {
	let valStg = pathString.replace(/\[/g, '.').replace(/\]/g, '').replace(/\"/g, '').replace(/\'/g, '').split('.').reduce((obj, key) => (obj || {})[key], obj);
	return isNaN(valStg) ? valStg : Number(valStg);
}

/**
 * Update an endpoint and send endpoint data to the given websocket
 * @param {Object} point - object containing the settings for the endpoint
 * @param {Object} [ws] - the websocket on which to send data
 * @param {Object} [wss] - the full set of ws clients (in which case, it will update all clients on tick)
 */
async function endpointTick(point, ws, wss) {
	try {
		let rawDta;
		if (point.socket) rawDta = await fetchSocket(point.socket.url, point.socket.port, point.socket.netCmnd, point.dataTimeoutMS);
		else if (point.web) rawDta = await fetchWebDta(point.web.url, point.dataTimeoutMS, point.name);
		else if (point.mqtt) return await setupMqtt(point, ws, wss);
		point.lastData = { "raw": rawDta };
		for (const key of Object.keys(point.variableData)) {
			if (point.variableData[key].findRange) {
				let ldr;
				for (let i = point.variableData[key].pathRangeMin; i < point.variableData[key].pathRangeMax; i++) {
					let curVal = getValue(rawDta, point.variableData[key].path.replace('?', i));
					if (!ldr || (point.variableData[key].findRange === 'max' && curVal > ldr) || (point.variableData[key].findRange === 'min' && curVal < ldr)) ldr = curVal;
				}
				point.lastData[key] = (ldr * (point.variableData[key].multiplier || 1)) + (point.variableData[key].offset || 0);
			} else {
				let dta = getValue(rawDta, point.variableData[key].path);
				point.lastData[key] = isNaN(dta) ? dta : (getValue(rawDta, point.variableData[key].path) * (point.variableData[key].multiplier || 1)) + (point.variableData[key].offset || 0);
			}
			copyLastDataToHistory(point, key);
			if (point.variableData[key].calculateRangePercent) {
				if (!point.variableData[key].rangeMin || point.lastData[key] < point.variableData[key].rangeMin) point.variableData[key].rangeMin = point.lastData[key];
				if (!point.variableData[key].rangeMax || point.lastData[key] > point.variableData[key].rangeMax) point.variableData[key].rangeMax = point.lastData[key];
			}
			if ((point.variableData[key].notification && point.variableData[key].notification.lowThreshold && (point.lastData[key] <= point.variableData[key].notification.lowThreshold)) ||(point.variableData[key].notification && point.variableData[key].notification.highThreshold && (point.lastData[key] >= point.variableData[key].notification.highThreshold))) sendNotification(point.variableData[key].notification);
		}
		wsSendPoint(ws, wss, point, 'From endpointTick(): ');
	} catch(err) { err.message = 'Error in endpointTick(' + point.name + '): ' + err.message; logErr(err); }
	if (point.updateAfter) endpointTick(settings.endPoints[point.updateAfter], ws, wss);
}

/**
 * Update all endpoints and send updated data to the given websocket
 * @param {Object} ws - the websocket on which to send updated endpoint data
 */
function updateEndPoints(ws, sendExsistingFirst) {
	for (const pointName of Object.keys(settings.endPoints)) {
		if (sendExsistingFirst) wsSendPoint(ws, null, settings.endPoints[pointName], 'Error from updateEndPoints() updating ' + pointName + ': '); // send existing data immediatly
		endpointTick(settings.endPoints[pointName], ws);
	}
}


/**
 * Entry Point
 */
const server = http.createServer();
server.filesCache = {
	"pageTemplate.html": {"path": "./pageTemplate.html", "head": { "Content-Type": "text/html" }},
	"bootstrap.min.css": {"path": "./bootstrap.min.css", "head": { "Content-Type": "text/css" }},
	"clientScript.js": {"path": "./clientScript.js", "head": { "Content-Type": "text/javascript" }}
};
for (const fileName of Object.keys(server.filesCache)) {
	fs.readFile(server.filesCache[fileName].path, function(err, data) {
		if (err) { err.message = 'fs error getting file ' + fileName + ': ' + err.message; return logErr(err); throw(err); }
		else server.filesCache[fileName].contents = data;
	});	
}
server.on('request', (request, response) => {
	try {
		let fileName = path.basename(request.url);
		if (request.url.endsWith('/') || fileName === '' || fileName === 'index.html' || fileName === 'index.htm') fileName = 'pageTemplate.html';
		if (server.filesCache[fileName]) {
			response.writeHead(200, server.filesCache[fileName].head);
			response.end(server.filesCache[fileName].contents);		
		} else {
			logErr(new Error('Client requested a file not in server.filesCache: "' + request.url + '" (parsed to filename: ' + fileName + ')'));
			response.writeHead(404, {"Content-Type": "text/plain"});
			response.end('404 Not Found\n');	
		}
	} catch(err) { err.message = 'Error in server.on("request") for url ' + request.url + ': ' + err.message; logErr(err); }
});
server.listen(settings.server.port, err => {
	if (err) { err.message = 'Server Error: ' + err.message; return logErr(err); }
	else {
		const wss = new WebSocket.Server({server});
		for (const pointName of Object.keys(settings.endPoints)) {
			settings.endPoints[pointName].timer = setInterval(() => endpointTick(settings.endPoints[pointName], null, wss), settings.endPoints[pointName].refreshMS);
			endpointTick(settings.endPoints[pointName], null, wss);
		}
		wss.on('connection', ws => {
			function closeWs(ws, err) {
				if (err && !err.message.includes('CLOSED')) console.warn('pingTimer error: ' + err.toString() + '\n' + err.stack);
				clearInterval(ws.pingTimer);
				return ws.terminate();
			}
			ws.isAlive = true;
			ws.on('message', message => { if (message === 'update') updateEndPoints(ws); else if (message === 'resetNotifications') resetNotifications(); });
			ws.on('pong', () => ws.isAlive = true);
			ws.pingTimer = setInterval(() => {
				if (ws.isAlive === false) return closeWs(ws);
				ws.isAlive = false;
				ws.ping(err => { if (err) return closeWs(ws, err); });
			}, settings.server.pingInterval);
			updateEndPoints(ws, true);
		});
		console.log('Server ' + settings.server.name + ' (http' + (settings.server.https ? 's://' : '://') + settings.server.address + ') is listening on port ' + settings.server.port);
	}
});
