# Koreader-Context-Creator

A koreader plugin for building context around characters/places/objects/concepts as you read.
The idea:

- When reading an EPUB if you hold down on a word (presumably a character name, a location or something of interest), a window pops up where you can write dot points about the "thing"
- For example if you highlight a characters name you can write dot points about them as you go so you have context for later in the book or if you are coming back after not reading for a while
- Needs to work for variations of a word like "s" or "'s" at the end etc
- Once thats functional I want to be able to create links between multiple of these
- Want to create a page/file in koreader accessible outside of the book where you can view a list of all of these you have made
- With the links feature maybe a clickable graph with connections between them? Sounds hard to implement in koreader though

Will be first time writing Lua, have a little bit of experience with Koreader plugins and wanted to make my own.

Testing using a MAC build of Koreader and pasting the plugin into the plugins folder (which is extremely buggy).

Another idea: Make the json file for a book importable to a web app for the graph idea? Sounds cool for people who like character maps, especially for when the relationships between contexts feature gets added
