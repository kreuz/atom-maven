'use babel';
'use strict';

const common = require('./common');

class PomRegistry {

	constructor() {
		this.registry = new Map();
		this.repo = common.homeDir + common.fileSeparator + '.m2' + common.fileSeparator + 'repository' + common.fileSeparator;
	}

}

PomRegistry.prototype.has = function (key) {
	return this.registry.has(key);
};

PomRegistry.prototype.put = function (key, value) {
	if (!this.has(key) && (key.indexOf('undefined') < 0)) {
		this.registry.set(key, value);
	} else {
		console.warn('Attempt to overwrite pom file was blocked', key, value);
	}
};

PomRegistry.prototype.get = function (key) {
	return this.registry.get(key);
};

PomRegistry.prototype.contains = function (key, value) {
	if (value) {
		for (var v of this.registry.values()) {
			if (v.equals(value)) {
				return v;
			}
		}
	} else {
		return this.registry.get(key);
	}
	return null;
};

module.exports = new PomRegistry();
