if (new URLSearchParams(location.search).has("bad")) {
	const error = document.getElementById("loginError");
	error.hidden = false;
	document.getElementById("password").focus();
}
