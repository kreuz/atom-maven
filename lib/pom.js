'use babel';
'use strict';

const ui = require('./ui-utils');
const eventManager = require('events');
const pomUtility = require('./pom-utils');

class Pom {

	constructor(opts, path, callback, factory) {
		var self = this;
		if (callback && typeof callback === 'function') {
			self.registerLoadCompleteEvent(callback);
		}
		self.factory = factory;
		self.classpathScopes = ['compile', 'provided', 'test'];
		self.hasChanged = true;
		self.changing = true;
		if (!self.existsInRepo) {
			self.existsInRepo = self.file.fileExists(path, false);
		}
		if (path) {
			self.pomPath = path;
		}
		if (opts) {
			self.init(opts);
			self.initialised = true;
		}
		self.reload(() => {
			if (opts && !self.initialised) {
				self.init(opts);
			} else if (!self.initialised) {
				self.init(pomUtility.getGAVT(self, self.project, 'pom'));
			}
		});
	}

}

Pom.prototype.common = require('./common');
Pom.prototype.$ = require('jquery');
Pom.prototype._ = require('underscore');
Pom.prototype.fs = require('fs');
Pom.prototype.xml2js = require('xml2js').Parser();
Pom.prototype.file = require('./file-utils');
Pom.prototype.registry = require('./pom-registry');
Pom.prototype.workspace = require('./workspace');
Pom.prototype.events = new eventManager.EventEmitter();

Pom.prototype.init = function (opts) {
	var self = this;
	self.groupId = opts.groupId;
	self.artifactId = opts.artifactId;
	self.version = opts.version;
	self.packaging = self.getPackaging();
	self.optional = opts.optional || false;
	if (opts.type) {
		self.type = opts.type;
	}
	if (opts.scope) {
		self.scope = opts.scope;
	}
	self.repoLocation = pomUtility.getDependencyRepoLocation(self, 'pom');
	if (!self.pomPath) {
		self.pomPath = (opts.pomPath) ? opts.pomPath : self.repoLocation;
	}
	self.setupEvents();
};

Pom.prototype.setupEvents = function () {
	const self = this;
	self.eventPrefix = self.groupId + ':' + self.artifactId + ':' + self.version + ':';

	var buildEvent = function (suffix, callback) {
		if (self.events.listenerCount(self.events, self.eventPrefix + suffix) === 0) {
			self.events.addListener(self.eventPrefix + suffix, callback);
		}
	};

	buildEvent('loaded', () => {
		self.loadParent(self);
	});

	buildEvent('parentUpdated', () => {
		self.loadProperties(self);
	});

	buildEvent('propertiesUpdated', () => {
		if (self.hasDependencyManagement(self)) {
			self.loadDependencyManagement(self);
		} else if (self.hasDependencies(self)) {
			self.loadDependencies(self);
		} else {
			self.loadClasspath(self);
		}
	});

	buildEvent('dependencyManagementUpdated', () => {
		if (!self.hasDependencyManagement(self) || (self.dependencyManagement && (self.dependencyManagement.length === self.getDependencyManagement(self).length))) {
			self.loadDependencies(self);
		}
	});

	buildEvent('dependenciesUpdated', () => {
		if (!self.hasDependencies(self) || (self.dependencies && (self.dependencies.length >= self.getDependencies(self).length))) {
			self.loadClasspath(self);
		}
	});

	buildEvent('classpathUpdated', () => {
		self.changing = false;
		self.rebuildOther(self, 'children', 'loadDependencyManagement');
		self.rebuildOther(self, 'dependants', 'loadClasspath');
		self.complete = true;
		if (self.loadCompleteEvents && self.loadCompleteEvents.length > 0) {
			for (var loadCompleteEvent of self.loadCompleteEvents) {
				loadCompleteEvent.action(self);
				loadCompleteEvent.queued = false;
			}
		}
	});
};

Pom.prototype.registerChangeEvent = function (callback) {
	var self = this;
	if (self.pomPath) {
		if (!self.changeEvents) {
			self.changeEvents = [];
		}
		self.changeEvents.push(callback);
		self.fs.watch(self.pomPath, () => {
			callback();
		});
	}
};

Pom.prototype.registerLoadCompleteEvent = function (callback) {
	var self = this;
	if (!self.loadCompleteEvents) {
		self.loadCompleteEvents = [];
	}

	var loadEvent = {
		action: callback,
		queued: false
	};

	self.loadCompleteEvents.push(loadEvent);
};

Pom.prototype.loadParent = function (pom) {
	var parentGAVT = pom.getParent();
	var parentPomPath = '';
	var promise = null;
	if (parentGAVT) {
		parentPomPath = pomUtility.getDependencyRepoLocation(parentGAVT, 'pom');
		promise = pom.factory(parentPomPath, parentGAVT);
		promise.then((parent) => {
			if (!parent.children) {
				parent.children = [];
			}
			if (parent.contains && !parent.contains(parent.children, pom)) {
				parent.children.push(pom);
				pom.parent = parent;
			}
			var isParentLoaded = setInterval(() => {
				if (!parent.changing) {
					clearInterval(isParentLoaded);
					pom.events.emit(pom.eventPrefix + 'parentUpdated');
				}
			}, 2e3);

		});
	} else {
		pom.events.emit(pom.eventPrefix + 'parentUpdated');
	}
};

Pom.prototype.loadProperties = function (pom) {
	if (pom.hasProperties()) {
		pom.properties = pom.getProperties();
	}
	pom.events.emit(pom.eventPrefix + 'propertiesUpdated');
};

Pom.prototype.loadDependencyManagement = function (pom) {
	var dependencyManagement = [];
	if (pom.hasDependencyManagement()) {
		var managedDependencies = pom.getDependencyManagement();
		var callback = function (managed) {
			dependencyManagement.push(managed);
			if (dependencyManagement.length >= managedDependencies.length) {
				pom.dependencyManagement = dependencyManagement;
				pom.events.emit(pom.eventPrefix + 'dependencyManagementUpdated');
			}
		};
		for (var dependency of managedDependencies) {
			pom.loadDependency(pom, dependency, true, callback);
		}
	} else {
		pom.events.emit(pom.eventPrefix + 'dependencyManagementUpdated');
	}
};

Pom.prototype.loadDependencies = function (pom) {

	var deps = [];
	if (pom.hasDependencies()) {
		var dependencies = pom.getDependencies();
		var callback = function (loaded) {
			deps.push(loaded);
			if (deps.length >= dependencies.length) {
				pom.dependencies = deps;
				pom.events.emit(pom.eventPrefix + 'dependenciesUpdated');
			}
		};
		for (var index in dependencies) {
			if (!this._.isEmpty(index) && index >= 0) {
				pom.loadDependency(pom, dependencies[index], false, callback);
			}
		}
	} else {
		pom.events.emit(pom.eventPrefix + 'dependenciesUpdated');
	}
};

Pom.prototype.loadDependency = function (pom, dependency, managed, callback) {
	var dependencyGAVT = pomUtility.getGAVT(pom, dependency);
	var path = pomUtility.getDependencyRepoLocation(dependencyGAVT, 'pom');
	var promise = null;
	if (managed) {
		if (callback && typeof callback === 'function') {
			callback(dependencyGAVT);
		}
	} else {
		promise = pom.factory(path, dependencyGAVT, pom);
		promise.then((real) => {
			if (!real.dependants) {
				real.dependants = [];
			}
			if (pom.contains && !pom.contains(real.dependants, pom)) {
				real.dependants.push(pom);
			}
			if (callback && typeof callback === 'function') {
				callback(real);
			}
		});
	}
};

Pom.prototype.loadClasspath = function (pom) {
	const self = pom || this;
	var classpath = [];

	var classpathContains = function (dependency) {
		for (var entry of classpath) {
			if ((entry.dependency.groupId === dependency.groupId && entry.dependency.artifactId === dependency.artifactId) ||
				(entry.dependency.groupId === dependency.dependency.groupId && entry.dependency.artifactId === dependency.dependency.artifactId)) {
				return true;
			}
		}
		return false;
	};

	var newClasspathElement = function (path, xml, dependency, pom) {
		return {
			file: path,
			source: pom,
			xml: xml,
			dependency: dependency
		};
	};

	self.addProjectDependenciesToClasspath(self, classpath, newClasspathElement);
	self.addParentalDependenciesToClasspath(self, classpath, newClasspathElement, classpathContains);
	self.addTransitiveDependenciesToClasspath(self, classpath, newClasspathElement, classpathContains);
	self.addParentalTransitiveDependenciesToClasspath(self, classpath, classpathContains);

	self.classpath = classpath;
	self.events.emit(self.eventPrefix + 'classpathUpdated');

};

/*
 * Add the project dependencies to the classpath
 */
Pom.prototype.addProjectDependenciesToClasspath = function (pom, classpath, factory) {
	if (pom.dependencies && pom.dependencies.length > 0) {
		for (var projectDependency of pom.dependencies) {
			classpath.push(factory(pom.pomPath, pom.xml, projectDependency, pom));
		}
	}
};

/*
 * Add the parental dependencies to the classpath
 */
Pom.prototype.addParentalDependenciesToClasspath = function (pom, classpath, factory, condition) {
	if (pom.parent && pom.parent.dependencies) {
		for (var parentDependency of pom.parent.dependencies) {
			var parentClasspathElement = factory(pom.parent.pomPath, pom.parent.xml, parentDependency, pom.parent);
			if (!condition(parentClasspathElement)) {
				classpath.push(parentClasspathElement);
			}
		}
	}
};

/*
 * Add transitive dependencies to the classpath
 */
Pom.prototype.addTransitiveDependenciesToClasspath = function (pom, classpath, factory, condition) {
	var notTestScoped = function (dependency) {
		if ((dependency && dependency.scope && dependency.scope === 'test') ||
			(dependency && dependency.dependency && dependency.dependency.scope && dependency.dependency.scope === 'test')) {
			return false;
		} else {
			return true;
		}
	};

	if (pom.dependencies && pom.dependencies.length > 0) {
		for (var dependency of pom.dependencies) {
			if (dependency.classpath && notTestScoped(dependency) && !dependency.optional) {
				for (var transitiveClasspathElement of dependency.classpath) {
					if (!condition(transitiveClasspathElement) && notTestScoped(transitiveClasspathElement) && !transitiveClasspathElement.dependency.optional) {
						classpath.push(transitiveClasspathElement);
					}
				}
			}
		}
	}
};

/*
 * Add parental transitive dependencies
 */
Pom.prototype.addParentalTransitiveDependenciesToClasspath = function (pom, classpath, condition) {
	if (pom.parent && pom.parent.classpath) {
		for (var parentElement of pom.parent.classpath) {
			if (!condition(parentElement)) {
				classpath.push(parentElement);
			}
		}
	}
};

Pom.prototype.hasContent = function (obj) {
	if (obj && obj.length > 0) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.getPackaging = function (target) {
	var pom = target || this;
	if (pom.project &&
		this.hasContent(pom.project.packaging)) {
		return pom.project.packaging[0];
	} else {
		return "jar";
	}
};

Pom.prototype.hasParent = function (target) {
	var pom = target || this;
	if (pom.project &&
		this.hasContent(pom.project.parent)) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.getParent = function (target) {
	var pom = target || this;
	return (pom.hasParent(pom)) ? pomUtility.getGAVT(pom, pom.project.parent[0], 'pom') : null;
};

Pom.prototype.hasDependencyManagement = function (target) {
	var pom = target || this;
	if (pom.project &&
		this.hasContent(pom.project.dependencyManagement) &&
		this.hasContent(pom.project.dependencyManagement[0].dependencies) &&
		this.hasContent(pom.project.dependencyManagement[0].dependencies[0].dependency)) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.getDependencyManagement = function (target) {
	var pom = target || this;
	return (pom.hasDependencyManagement(pom)) ? pom.project.dependencyManagement[0].dependencies[0].dependency : [];
};

Pom.prototype.hasDependencies = function (target) {
	var pom = target || this;
	if (pom.project &&
		pom.hasContent(pom.project.dependencies) &&
		pom.hasContent(pom.project.dependencies[0].dependency)) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.getDependencies = function (target) {
	var pom = target || this;
	return (pom.hasDependencies(pom)) ? pom.project.dependencies[0].dependency : [];
};

Pom.prototype.hasProperties = function (target) {
	var pom = target || this;
	if (pom.project && pom.hasContent(pom.project.properties)) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.getEnvironmentProperties = function (pom, properties) {
	var envs = process.env;
	for (var key in envs) {
		if (!properties.hasOwnProperty(key)) {
			continue;
		}
		if (properties[key].length === 1) {
			properties.push(pom.newProperty('env.' + key.toUpperCase(), envs[key]));
		}
	}
};

Pom.prototype.getProjectProperties = function (pom, properties) {
	var setProjectProperties = function (item) {
		properties.push(pom.newProperty('project.groupId', item.groupId));
		properties.push(pom.newProperty('project.artifactId', item.artifactId));
		properties.push(pom.newProperty('project.version', item.version));
	};
	if (pom && pom.groupId && pom.artifactId && pom.version) {
		setProjectProperties(pom);
	} else {
		var GAVT = pomUtility.getGAVT(pom, pom.project, 'pom');
		setProjectProperties(GAVT);
	}
};

Pom.prototype.getProperties = function (target) {
	var pom = target || this;
	var props = [];
	var properties = [];
	pom.getEnvironmentProperties(pom, props);
	pom.getProjectProperties(pom, props);
	if (pom.hasProperties(pom)) {
		properties = pom.project.properties[0];
		for (var key in properties) {
			if (!properties.hasOwnProperty(key)) {
				continue;
			}
			if (properties[key].length === 1) {
				props.push(pom.newProperty(key, properties[key][0]));
			}
		}
	}
	return props;
};

Pom.prototype.newProperty = function (key, value) {
	return {
		key: key,
		value: value
	};
};

Pom.prototype.resolveProperty = function (property, pom) {
	var result = property;
	const self = this;
	if (property && property.startsWith('${') && property.endsWith('}')) {
		if (self.properties) {
			for (var prop of self.properties) {
				if (property.indexOf(prop.key) > -1) {
					result = prop.value;
				}
			}
		}
		if (result === property && pom) {
			result = pom.resolveProperty(property, pom.parent);
		}
	}
	return result;
};

Pom.prototype.iterateDependencyCollection = function (collection, attribute, groupId, artifactId) {
	var result;
	for (var managed of collection) {
		if (managed.groupId === groupId && managed.artifactId === artifactId) {
			result = managed[attribute];
			break;
		}
	}
	return result;
};

/**
 *  attribute = 'version' || 'scope'
 */
Pom.prototype.resolveAttributeValue = function (groupId, artifactId, version, pom, attribute) {
	const self = this;
	var resultContainer = {
		attribute: attribute,
		groupId: groupId,
		artifactId: artifactId,
		pom: pom,
		value: null
	};

	if (self._.isEmpty(version)) {
		self.resolveAttributeValueFromDependencyManagement(resultContainer);
		self.resolveAttributeValueFromDepenencies(resultContainer);
		self.resolveAttributeValueFromParent(resultContainer);
	}
	return resultContainer.value || version;
};

Pom.prototype.resolveAttributeValueFromDependencyManagement = function (container) {
	const self = this;
	var returned;
	if (container.pom.dependencyManagement) {
		returned = self.iterateDependencyCollection(container.pom.dependencyManagement, container.attribute, container.groupId, container.artifactId);
		if (returned) {
			container.value = returned;
		}
	}
};

Pom.prototype.resolveAttributeValueFromDepenencies = function (container) {
	const self = this;
	var returned;
	if (container.pom.dependencies) {
		returned = self.iterateDependencyCollection(container.pom.dependencies, container.attribute, container.groupId, container.artifactId);
		if (returned) {
			container.value = returned;
		}
	}
};

Pom.prototype.resolveAttributeValueFromParent = function (container) {
	const self = this;
	var returned;
	if (self._.isEmpty(container.value) && container.pom.parent) {
		returned = self.resolveAttributeValue(container.groupId, container.artifactId, container.value, container.pom.parent, container.attribute);
		if (returned) {
			container.value = returned;
		}
	}
};

Pom.prototype.equals = function (other) {
	if ((this.groupId === other.groupId) &&
		(this.artifactId === other.artifactId) &&
		(this.version === other.version)) {
		return true;
	} else {
		return false;
	}
};

Pom.prototype.reload = function (callback) {
	var self = this;
	if ((!self.changing || self.hasChanged) && self.existsInRepo) {
		self.changing = true;
		self.hasChanged = false;
		self.fs.readFile(self.pomPath, 'utf8', (err, xml) => {
			if (err) {
				console.error(self.pomPath, err);
			}
			self.xml = xml;
			self.xml2js.parseString(xml, function (err, result) {
				if (err) {
					ui.error(err);
				}
				self.$.extend(self, result);
				if (callback && typeof callback === 'function') {
					callback();
				}
				self.events.emit(self.eventPrefix + 'loaded');
			});
		});
	}
};

Pom.prototype.contains = function (collection, item) {
	for (var elem of collection) {
		if (elem && elem.equals && elem.equals(item)) {
			return true;
		} else if (item && item.equals && item.equals(elem)) {
			return true;
		}
	}
	return false;
};

Pom.prototype.rebuildOther = function (pom, attribute, otherAttr) {
	if (pom && pom[attribute]) {
		for (var child of pom[attribute]) {
			child[otherAttr](child);
		}
	}
};

module.exports = Pom;
