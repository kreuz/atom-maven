class Workspace {

	constructor() {
		this.poms = [];
	}

};

Workspace.prototype.add = function (pom) {
	this.poms.push(pom);
}

Workspace.prototype.contains = function (pom) {
	var contains = null;
	$.each(this.poms, (index, elem) => {
		if (elem && elem.equals(pom)) {
			contains = elem;
			return false;
		}
	});
	return contains;
}

module.exports = new Workspace();